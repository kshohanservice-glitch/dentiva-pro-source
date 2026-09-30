/**
 * Local file logger.
 *
 * Dentiva Pro never sends diagnostics anywhere: logs stay in the per-user
 * application data folder, rotate at a fixed size and are only read by the
 * clinic's own administrator.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Scoped child logger: every message is prefixed with `scope`. */
  child(scope: string): Logger;
  /** Last `lines` entries from the active log file (for the diagnostics screen). */
  tail(lines: number): string[];
}

export interface LoggerOptions {
  readonly directory: string;
  readonly minLevel?: LogLevel;
  readonly fileName?: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly mirrorToConsole?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function safeStringify(meta: Record<string, unknown> | undefined): string {
  if (!meta) return '';
  const seen = new WeakSet<object>();
  try {
    return ` ${JSON.stringify(meta, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      if (value instanceof Error) return { name: value.name, message: value.message };
      return value;
    })}`;
  } catch {
    return ' [unserialisable meta]';
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const {
    directory,
    minLevel = 'info',
    fileName = 'dentiva.log',
    maxBytes = 2 * 1024 * 1024,
    maxFiles = 10,
    mirrorToConsole = false,
  } = options;

  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    // A read-only data folder must not crash the application; logging degrades gracefully.
  }

  const activePath = join(directory, fileName);

  const rotateIfNeeded = (): void => {
    try {
      if (!existsSync(activePath)) return;
      const size = statSync(activePath).size;
      if (size < maxBytes) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      renameSync(activePath, join(directory, `${fileName}.${stamp}.log`));
      const archived = readdirSync(directory)
        .filter((name) => name.startsWith(`${fileName}.`) && name.endsWith('.log'))
        .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      for (const stale of archived.slice(maxFiles)) {
        unlinkSync(join(directory, stale.name));
      }
    } catch {
      // Rotation failure must never break the application.
    }
  };

  const write = (level: LogLevel, scope: string | null, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${
      scope ? `[${scope}] ` : ''
    }${message}${safeStringify(meta)}`;
    if (mirrorToConsole) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.warn(line);
    }
    try {
      rotateIfNeeded();
      appendFileSync(activePath, `${line}\n`, 'utf8');
    } catch {
      // Never throw from the logger.
    }
  };

  const make = (scope: string | null): Logger => ({
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
    child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
    tail: (lines) => {
      try {
        if (!existsSync(activePath)) return [];
        const content = readFileSync(activePath, 'utf8');
        const all = content.split('\n').filter((line) => line !== '');
        return all.slice(Math.max(0, all.length - lines));
      } catch {
        return [];
      }
    },
  });

  return make(null);
}

/** Logger used by unit tests and headless tooling. */
export function createNullLogger(): Logger {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createNullLogger(),
    tail: () => [],
  };
}

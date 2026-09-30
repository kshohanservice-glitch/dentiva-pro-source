/**
 * The renderer's single connection to the application core.
 *
 * Inside the desktop app `window.dentiva` is injected by the preload script and
 * talks over Electron IPC. When the UI is opened in a plain browser (the
 * development bridge, or an automated UI check) the same interface is served
 * over HTTP: `POST /api/invoke` mirrors `invoke`, and `/api/events` is a
 * server-sent-event stream that mirrors the main-process broadcasts. Nothing
 * else in the renderer knows which of the two it is talking to.
 */
import type {
  ApiMethodName,
  ApiRequest,
  ApiResponse,
  BridgeEventName,
  BridgeEventPayloads,
  BridgeInvokeResult,
  DentivaBridge,
} from '@shared/api';

declare global {
  interface Window {
    dentiva?: DentivaBridge & { pathForFile?(file: File): string };
  }
}

export interface BridgeFailure extends Error {
  code: string;
  fieldErrors?: Record<string, string>;
}

function failure(message: string, code: string, fieldErrors?: Record<string, string>): BridgeFailure {
  const error = new Error(message) as BridgeFailure;
  error.code = code;
  if (fieldErrors) error.fieldErrors = fieldErrors;
  return error;
}

type Listener = (payload: unknown) => void;
const listeners = new Map<BridgeEventName, Set<Listener>>();
let source: EventSource | null = null;

function ensureEventStream(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      const parsed: unknown = JSON.parse(String(message.data));
      if (typeof parsed !== 'object' || parsed === null) return;
      const event = parsed as { name?: unknown; payload?: unknown };
      if (typeof event.name !== 'string') return;
      const set = listeners.get(event.name as BridgeEventName);
      if (!set) return;
      for (const listener of set) listener(event.payload);
    } catch {
      /* keep-alive comments and malformed frames are ignored */
    }
  };
  source.onerror = () => {
    // EventSource reconnects on its own; nothing to do here.
  };
}

const httpBridge: DentivaBridge = {
  isElectron: false,
  versions: {},
  async invoke<K extends ApiMethodName>(method: K, payload?: ApiRequest<K>): Promise<ApiResponse<K>> {
    let response: Response;
    try {
      response = await fetch('/api/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }),
      });
    } catch {
      throw failure('The application service is not reachable.', 'IO');
    }
    if (!response.ok) throw failure('The application did not answer.', 'UNKNOWN');
    const result = (await response.json()) as BridgeInvokeResult<ApiResponse<K>>;
    if (!result || typeof result !== 'object') throw failure('The application did not answer.', 'UNKNOWN');
    if (result.ok) return result.data;
    throw failure(result.error.message, result.error.code, result.error.fieldErrors);
  },
  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEventPayloads[E]) => void): () => void {
    ensureEventStream();
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener as Listener);
    listeners.set(event, set);
    return () => {
      set.delete(listener as Listener);
      if (set.size === 0) listeners.delete(event);
    };
  },
};

export const bridge: DentivaBridge = window.dentiva ?? httpBridge;
export const isElectron = Boolean(window.dentiva?.isElectron);
export const appVersions: Readonly<Record<string, string>> = bridge.versions ?? {};

/** Absolute path of a dragged/dropped file (Electron removed `File.path`). */
export function pathForFile(file: File): string | null {
  const api = window.dentiva;
  if (api?.pathForFile) {
    try {
      return api.pathForFile(file) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Upload a browser-provided file to the dev bridge and return its temp path. */
export async function uploadFile(file: File): Promise<string> {
  const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) throw failure('The file could not be uploaded.', 'IO');
  const parsed = (await response.json()) as { path?: string };
  if (!parsed.path) throw failure('The file could not be uploaded.', 'IO');
  return parsed.path;
}

/** Resolve a file for a picker-free flow: Electron gives a path, the browser uploads. */
export async function resolveSourcePath(file: File): Promise<string> {
  const native = pathForFile(file);
  if (native) return native;
  return uploadFile(file);
}

export function apiErrorCode(error: unknown): string {
  return (error as BridgeFailure)?.code ?? 'UNKNOWN';
}

export function apiFieldErrors(error: unknown): Record<string, string> | undefined {
  return (error as BridgeFailure)?.fieldErrors;
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

/**
 * Development bridge.
 *
 * The real application is an Electron window talking over IPC. During
 * development (and for automated UI checks) the very same router is served over
 * HTTP on `DENTIVA_DEV_BRIDGE_PORT` (4319 by default) so the renderer can run in
 * a plain browser: `POST /api/invoke` mirrors `window.dentiva.invoke`, and
 * `GET /api/events` is a server-sent-event stream that mirrors the main-process
 * broadcasts. The desktop build never imports this file.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createCoreContainer, type CoreContainer } from '@core/container';
import { createLogger } from '@core/util/logger';
import { APP_BUILD_NUMBER, APP_NAME, APP_VERSION } from '@shared/app-info';
import { sanitiseFileName } from '@core/util/files';
import { createRouter } from './ipc/router';
import type { MainPorts } from './ipc/handlers';
import type { PrintHostPort, PrintRenderOptions } from '@core/services/print-service';
import type { SystemPrinter } from '@shared/types';
import { AppError } from '@shared/errors';

export interface DevBridgeOptions {
  readonly port: number;
  readonly dataDir: string;
  readonly host?: string;
  /** Logs every invocation — handy while developing the renderer. */
  readonly verbose?: boolean;
}

export interface DevBridgeHandle {
  readonly url: string;
  readonly container: CoreContainer;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Chromium-backed print host used when `DENTIVA_CHROMIUM` points at a browser. */
function createDevPrintHost(tempDir: string): PrintHostPort {
  const executablePath = process.env['DENTIVA_CHROMIUM'] ?? '';
  let browser: import('puppeteer-core').Browser | null = null;

  async function page(): Promise<import('puppeteer-core').Page> {
    if (!executablePath) throw AppError.precondition('The browser preview cannot print without a Chromium binary.');
    if (!browser) {
      const puppeteer = await import('puppeteer-core');
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
      });
    }
    const created = await browser.newPage();
    return created;
  }

  async function render(html: string, options: PrintRenderOptions, landscape: boolean): Promise<Buffer> {
    const target = await page();
    try {
      await target.setContent(html, { waitUntil: 'load' });
      await target.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
      const pdf = await target.pdf({
        printBackground: true,
        landscape,
        preferCSSPageSize: true,
        scale: Math.min(2, Math.max(0.5, options.scalePercent / 100)),
      });
      return Buffer.from(pdf);
    } finally {
      await target.close();
    }
  }

  return {
    async listPrinters(): Promise<SystemPrinter[]> {
      return [
        {
          name: 'dev-pdf',
          displayName: 'Development PDF printer',
          description: 'Writes the document to the temporary folder.',
          status: 0,
          isDefault: true,
          options: {},
        },
      ];
    },
    async toPdf(html, options) {
      const buffer = await render(html, options, options.orientation === 'landscape');
      const path = join(tempDir, `dev-${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`);
      writeFileSync(path, buffer);
      return { path, pageCount: Math.max(1, countPages(buffer)), bytes: buffer.byteLength };
    },
    async send() {
      throw AppError.precondition('Printing to a physical printer needs the desktop application.');
    },
    async reveal(path) {
      console.log(`[dev-bridge] reveal ${path}`);
    },
  };
}

function countPages(buffer: Buffer): number {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

export async function startDevBridge(options: DevBridgeOptions): Promise<DevBridgeHandle> {
  const root = options.dataDir;
  const paths = {
    root,
    dataDir: join(root, 'data'),
    databasePath: join(root, 'data', 'dentiva.sqlite'),
    attachmentsDir: join(root, 'attachments'),
    backupsDir: join(root, 'backups'),
    logsDir: join(root, 'logs'),
    configDir: join(root, 'config'),
    tempDir: join(root, 'temp'),
    exportsDir: join(root, 'exports'),
  };
  for (const dir of [
    paths.root,
    paths.dataDir,
    paths.attachmentsDir,
    paths.backupsDir,
    paths.logsDir,
    paths.configDir,
    paths.tempDir,
    paths.exportsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const logger = createLogger({ directory: paths.logsDir, mirrorToConsole: options.verbose ?? false });
  let guid = 'dev-machine';
  const guidPath = join(paths.configDir, 'machine.json');
  try {
    guid = (JSON.parse(readFileSync(guidPath, 'utf8')) as { guid: string }).guid;
  } catch {
    guid = `dev-${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    writeFileSync(guidPath, JSON.stringify({ guid }), 'utf8');
  }

  const clients = new Set<ServerResponse>();
  const printHost = createDevPrintHost(paths.tempDir);

  const container = createCoreContainer({
    paths,
    machineGuid: guid,
    appVersion: APP_VERSION,
    appBuild: APP_BUILD_NUMBER,
    logger,
    printHost,
    fontCss: '',
    runtimeInfo: () => ({
      electronVersion: 'dev-bridge',
      chromeVersion: process.versions.v8 ?? '',
      nodeVersion: process.versions.node,
      osVersion: `${process.platform} ${process.arch}`,
      architecture: process.arch,
      locale: 'en',
    }),
    notify: (event, payload) => {
      if (event === 'notifications.changed') {
        try {
          const counts = container.services.notifications.unreadCount();
          const latest = container.services.notifications.list({ limit: 1 })[0] ?? null;
          push({ name: 'notifications.changed', payload: { unread: counts.total, critical: counts.critical, latest } });
        } catch {
          /* ignore */
        }
        return;
      }
      if (event === 'session.changed') {
        push({ name: 'session.changed', payload: { session: container.services.auth.session() } });
        return;
      }
      if (event === 'session.locked') {
        push({
          name: 'session.locked',
          payload: { reason: (payload?.['reason'] as string) ?? 'manual', at: container.context().instant() },
        });
        return;
      }
      if (event === 'session.unlocked') {
        const user = container.services.auth.session();
        if (user) push({ name: 'session.unlocked', payload: { userId: user.id, username: user.username } });
        return;
      }
      if (event === 'backup.progress' && payload) push({ name: 'backup.progress', payload });
    },
  });

  function push(message: unknown): void {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of clients) {
      if (!client.writableEnded) client.write(line);
    }
  }

  const ports: MainPorts = {
    async openPath(path, reveal) {
      console.log(`[dev-bridge] open${reveal ? ' (reveal)' : ''} ${path}`);
    },
    async openExternal(url) {
      console.log(`[dev-bridge] open external ${url}`);
    },
    relaunch() {
      console.log('[dev-bridge] relaunch requested');
    },
    quit() {
      console.log('[dev-bridge] quit requested');
    },
    async pickFiles() {
      // The browser has no native dialogs; the renderer uploads through
      // POST /api/upload and then calls the method again with a real path.
      return [];
    },
    async pickFolder() {
      return null;
    },
    hasOpenDialog() {
      return false;
    },
    async thumbnail() {
      return null;
    },
  };

  const router = createRouter({ container, ports });

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'UNKNOWN', message: String(error) } }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, app: APP_NAME, version: APP_VERSION, build: APP_BUILD_NUMBER }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': connected\n\n');
      clients.add(response);
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/invoke') {
      const body = (await readBody(request, 64 * 1024 * 1024)).toString('utf8');
      let parsed: { method?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(body || '{}') as { method?: unknown; payload?: unknown };
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'VALIDATION', message: 'Malformed request.' } }));
        return;
      }
      if (options.verbose) logger.debug('invoke', { method: parsed.method });
      const result = await router.invoke(String(parsed.method), parsed.payload ?? undefined);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/upload') {
      const name = sanitiseFileName(url.searchParams.get('name') ?? 'upload.bin', 'upload.bin');
      const body = await readBody(request, 128 * 1024 * 1024);
      const path = join(paths.tempDir, `${Date.now()}-${name}`);
      writeFileSync(path, body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path, name, bytes: body.byteLength }));
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/file/')) {
      const id = Number(url.pathname.slice('/api/file/'.length));
      try {
        const path = container.services.attachments.absolutePath(id);
        const data = readFileSync(path);
        response.writeHead(200, {
          'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'content-length': data.byteLength,
        });
        response.end(data);
      } catch {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Attachment not found.' } }));
      }
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: false,
        error: { code: 'NOT_FOUND', message: `No route for ${request.method ?? 'GET'} ${url.pathname}` },
      }),
    );
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  logger.info('Development bridge listening', { port, dataDir: root });
  console.log(`[dev-bridge] listening on http://0.0.0.0:${port} (data: ${root})`);

  return {
    url: `http://127.0.0.1:${port}`,
    container,
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      container.close();
    },
  };
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Error('The request is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

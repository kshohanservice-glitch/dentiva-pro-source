/**
 * Dentiva Pro — Electron main process.
 *
 * Responsibilities, in order: make sure only one copy runs, prepare the data
 * directories, open the database through the core container, create the window,
 * expose the IPC router, and keep the background housekeeping running
 * (auto-lock, notification refresh, automatic backups, clean-shutdown marker).
 *
 * No business logic lives here: the renderer talks to the router, the router
 * talks to `src/core`.
 */
import { BrowserWindow, Menu, app, ipcMain, session, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCoreContainer, type CoreContainer } from '@core/container';
import { createLogger } from '@core/util/logger';
import { APP_BUILD_NUMBER, APP_NAME, APP_VERSION } from '@shared/app-info';
import type { BridgeEventName } from '@shared/api';
import { machineGuid, resolveCorePaths } from './paths';
import { loadEmbeddedFontCss } from './fonts';
import { ElectronPrintHost, appTempDir } from './print-host';
import { applyPendingRestore, type PendingRestoreOutcome } from '@core/services/backup-service';
import { createRouter, type IpcRouter } from './ipc/router';
import { createElectronPorts } from './ports-electron';
import { collectSelfCheck } from './self-check';

const INVOKE_CHANNEL = 'dentiva:invoke';
/** `Dentiva Pro.exe --self-check` reports on the installation and exits. */
const SELF_CHECK_FLAG = '--self-check';
/**
 * Where the JSON report is also written. A packaged Windows build is a
 * GUI-subsystem executable: when another program starts it, its standard output
 * is not always connected, so the release pipeline reads the report from a file.
 *
 * `DENTIVA_SELF_CHECK_FILE` is the reliable form — an environment variable cannot
 * be swallowed by the platform's command-line handling, which is exactly what
 * happened to the flag on Windows CI. Both forms are read, and the report is
 * printed as well when a console is attached.
 */
const SELF_CHECK_FILE_FLAG = '--self-check-file=';

function selfCheckFile(): string | null {
  const fromEnvironment = process.env.DENTIVA_SELF_CHECK_FILE?.trim();
  if (fromEnvironment && fromEnvironment.length > 0) return fromEnvironment;
  const argument = process.argv.find((value) => value.startsWith(SELF_CHECK_FILE_FLAG));
  if (!argument) return null;
  const target = argument.slice(SELF_CHECK_FILE_FLAG.length).trim();
  return target.length > 0 ? target : null;
}

function isSelfCheckRun(): boolean {
  return process.argv.includes(SELF_CHECK_FLAG) || selfCheckFile() !== null;
}

/**
 * `DENTIVA_LAUNCH_TRACE=1` writes what the main process was started with, before
 * anything else happens. Diagnosing "the application did nothing" from a support
 * e-mail needs exactly this: the arguments, whether the self-check was recognised,
 * and which data folder was asked for. Off by default, and it never throws.
 */
if (process.env['DENTIVA_LAUNCH_TRACE'] === '1') {
  try {
    writeFileSync(
      join(app.getPath('temp'), 'dentiva-launch-trace.txt'),
      [
        `argv=${JSON.stringify(process.argv.slice(1))}`,
        `selfCheck=${String(isSelfCheckRun())}`,
        `selfCheckFile=${selfCheckFile() ?? 'unset'}`,
        `dataDir=${process.env['DENTIVA_DATA_DIR'] ?? 'unset'}`,
        `packaged=${String(app.isPackaged)}`,
        `startedAt=${new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    );
  } catch {
    // Diagnostics must never break the application.
  }
}

/**
 * Where a self-check report is written. The requested path comes first; the data
 * folder's own `logs` directory always gets a copy, so a support engineer can ask
 * for one file no matter how the application was started.
 */
function selfCheckWriteTargets(requested: string | null): string[] {
  const targets: string[] = [];
  if (requested) targets.push(requested);
  try {
    targets.push(join(resolveCorePaths().logsDir, 'self-check.json'));
  } catch {
    // The data folder itself is unusable; the requested path is all there is.
  }
  return targets;
}
const EVENT_CHANNEL = 'dentiva:event';
const BACKGROUND_TICK_MS = 15_000;
const NOTIFICATION_TICK_MS = 5 * 60_000;
const BACKUP_TICK_MS = 30 * 60_000;

let container: CoreContainer | null = null;
let router: IpcRouter | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Window state
// ---------------------------------------------------------------------------

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  zoom: number;
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'config', 'window-state.json');
}

function readWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900, maximized: false, zoom: 1 };
  try {
    const path = windowStatePath();
    if (!existsSync(path)) return fallback;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowState>;
    return {
      width: clamp(parsed.width ?? fallback.width, 1024, 7680),
      height: clamp(parsed.height ?? fallback.height, 720, 4320),
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      maximized: Boolean(parsed.maximized),
      zoom: clamp(parsed.zoom ?? 1, 0.5, 3),
    };
  } catch {
    return fallback;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  try {
    const bounds = window.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized(),
      zoom: window.webContents.getZoomFactor(),
    };
    writeFileSync(windowStatePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Losing the window position is never worth interrupting the user.
  }
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

function broadcast<E extends BridgeEventName>(name: E, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(EVENT_CHANNEL, { name, payload });
  }
}

function bootStrapping(): boolean {
  return !quitting;
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * Finish a restore that was staged before the last shutdown. This has to happen
 * before the database is opened — SQLite will not let us swap the file out from
 * under a live connection.
 */
async function finishStagedRestore(logger: ReturnType<typeof createLogger>): Promise<PendingRestoreOutcome | null> {
  const paths = resolveCorePaths();
  const outcome = await applyPendingRestore(paths, { logger });
  if (!outcome) return null;
  if (outcome.applied) logger.info('Staged restore applied', { source: outcome.sourceFile, files: outcome.attachmentsRestored });
  else logger.error('Staged restore could not be applied', { problem: outcome.problem });
  return outcome;
}

function startContainer(): CoreContainer {
  const paths = resolveCorePaths();
  const logger = createLogger({
    directory: paths.logsDir,
    minLevel: process.env['DENTIVA_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
    mirrorToConsole: !app.isPackaged,
  });
  const guid = machineGuid(paths.configDir);
  const fontCss = loadEmbeddedFontCss(app.getAppPath());
  const printHost = new ElectronPrintHost(appTempDir());

  const created = createCoreContainer({
    paths,
    machineGuid: guid,
    appVersion: APP_VERSION,
    appBuild: APP_BUILD_NUMBER,
    logger,
    printHost,
    fontCss,
    runtimeInfo: () => ({
      electronVersion: process.versions.electron ?? '',
      chromeVersion: process.versions.chrome ?? '',
      nodeVersion: process.versions.node ?? '',
      osVersion: `${process.platform} ${process.arch}`,
      architecture: process.arch,
      locale: app.getLocale(),
    }),
    notify: (event, payload) => {
      if (!bootStrapping()) return;
      if (event === 'notifications.changed') {
        try {
          const counts = created.services.notifications.unreadCount();
          const latest = created.services.notifications.list({ limit: 1 })[0] ?? null;
          broadcast('notifications.changed', { unread: counts.total, critical: counts.critical, latest });
        } catch {
          broadcast('notifications.changed', { unread: 0, critical: 0, latest: null });
        }
        return;
      }
      if (event === 'session.locked') {
        broadcast('session.locked', {
          reason: (payload?.['reason'] as 'manual' | 'idle' | 'security') ?? 'manual',
          at: created.context().instant(),
        });
        return;
      }
      if (event === 'session.unlocked') {
        const user = created.services.auth.session();
        if (user) broadcast('session.unlocked', { userId: user.id, username: user.username });
        return;
      }
      if (event === 'session.changed') {
        broadcast('session.changed', { session: created.services.auth.session() });
        broadcast('app.state.changed', { state: created.services.app.state() });
        return;
      }
      if (event === 'backup.progress' && payload) {
        broadcast('backup.progress', payload);
      }
      if (event === 'restore.relaunching') {
        const raw = payload?.['message'];
        const message = typeof raw === 'string' && raw !== '' ? raw : 'Dentiva Pro will restart to finish restoring your data.';
        broadcast('restore.relaunching', { message });
        // Give the window a moment to show the message, then restart so the
        // staged database is applied on the way back up.
        setTimeout(() => {
          quitting = true;
          try {
            container?.services.app.markShutdown(true);
          } catch {
            /* never block the restart */
          }
          app.relaunch();
          app.exit(0);
        }, 2500);
      }
    },
  });
  logger.info('Dentiva Pro started', { version: APP_VERSION, build: APP_BUILD_NUMBER, dataDir: paths.root });
  return created;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const state = readWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b1f33',
    autoHideMenuBar: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  if (state.maximized) window.maximize();
  window.webContents.setZoomFactor(state.zoom);

  window.once('ready-to-show', () => window.show());

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(window), 400);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  window.on('close', () => saveWindowState(window));

  // The renderer is a local, sandboxed document. Anything that tries to
  // navigate away or open a second window is refused and, for http(s) links,
  // handed to the user's browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['DENTIVA_DEV_SERVER_URL'];
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    container?.logger.error('Renderer process ended unexpectedly', { reason: details.reason });
  });

  const devUrl = process.env['DENTIVA_DEV_SERVER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
  return window;
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu(): void {
  const send = (shortcut: 'global-search' | 'new-record' | 'save' | 'print' | 'lock' | 'escape'): void => {
    broadcast('shortcut.invoke', { shortcut });
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'New patient', accelerator: 'CmdOrCtrl+N', click: () => send('new-record') },
        { label: 'Global search', accelerator: 'CmdOrCtrl+Shift+F', click: () => send('global-search') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        { label: 'Lock Dentiva Pro', accelerator: 'CmdOrCtrl+L', click: () => container?.services.auth.lock('manual') },
        { label: 'Sign out', click: () => container?.services.auth.logout() },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual size (100%)' },
        { role: 'zoomIn', label: 'Zoom in' },
        { role: 'zoomOut', label: 'Zoom out' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => send('global-search'),
        },
        {
          label: 'Open data folder',
          click: () => {
            if (container) void shell.openPath(container.paths.root);
          },
        },
        {
          label: 'Open log folder',
          click: () => {
            if (container) void shell.openPath(container.paths.logsDir);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

function startHousekeeping(): void {
  setInterval(() => {
    if (!container || quitting || !bootStrapping()) return;
    try {
      container.services.auth.enforceAutoLock();
    } catch (error) {
      container.logger.debug('Auto-lock tick failed', { error: (error as Error).message });
    }
  }, BACKGROUND_TICK_MS);

  setInterval(() => {
    if (!container || quitting || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      if (!container.services.auth.session()) return;
      container.services.notifications.refresh();
    } catch {
      // A missing permission or an ended session simply skips this tick.
    }
  }, NOTIFICATION_TICK_MS);

  setInterval(() => {
    if (!container || quitting) return;
    void container.services.backups
      .runAutomaticIfDue()
      .catch((error: unknown) => container?.logger.warn('Automatic backup skipped', { error: String(error) }));
  }, BACKUP_TICK_MS);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function registerIpc(): void {
  const ports = createElectronPorts({
    window: () => mainWindow,
  });
  const active = container;
  if (!active) return;
  router = createRouter({ container: active, ports });
  ipcMain.handle(INVOKE_CHANNEL, async (_event, method: unknown, payload: unknown) => {
    const active = router;
    if (!active) return { ok: false, error: { code: 'UNKNOWN', message: 'The application is still starting.' } };
    return active.invoke(String(method), payload);
  });
}

function applySecurityPolicy(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  // The packaged renderer is a local file: it may load its own bundled assets
  // and nothing else. In development Vite needs to inject its live-reload
  // client, so the policy is only applied to the packaged file:// documents.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src" +
              " 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          ],
        },
      });
    });
  }
}

/**
 * Tell the clinic what happened on the way up. A completed restore is written
 * into the audit trail and raised in the notification centre; a restore that
 * could not be applied is reported at critical severity so it cannot be missed.
 */
function reportRestoreOutcome(outcome: PendingRestoreOutcome): void {
  if (!container) return;
  try {
    const { audit, notifications, system } = container.services;
    const source = outcome.sourceFile ? basename(outcome.sourceFile) : 'a backup';
    if (outcome.applied) {
      const integrity = system.integrityCheck();
      audit.recordAction(
        'restore_completed',
        'backup',
        null,
        `Restored ${source} on restart — ${outcome.attachmentsRestored} file(s)` +
          ` copied, integrity check ${integrity.ok ? 'passed' : 'FAILED'}`,
        'critical',
      );
      notifications.create({
        category: 'backup',
        severity: integrity.ok ? 'info' : 'critical',
        title: 'Restore completed',
        message: `${source} was restored when Dentiva Pro restarted. ${outcome.attachmentsRestored} file(s) were copied back.`,
        dedupeKey: `restore-completed:${outcome.sourceFile}`,
      });
    } else {
      audit.recordAction(
        'restore_failed',
        'backup',
        null,
        `A staged restore could not be` + ` applied: ${outcome.problem ?? 'unknown problem'}`,
        'critical',
      );
      notifications.create({
        category: 'backup',
        severity: 'critical',
        title: 'Restore could not be applied',
        message: outcome.problem ?? 'The staged restore was cancelled. Your data has not been changed.',
        dedupeKey: `restore-failed:${outcome.problem ?? 'unknown'}`,
      });
    }
    notifications.refresh();
  } catch (error) {
    container?.logger.error(`Could not report the restore outcome: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run the installation self-check and exit. Used by the release pipeline after
 * installing the packaged application, and by support to diagnose a machine
 * without opening the clinic database for writing.
 */
function runSelfCheckAndExit(): void {
  const startedWithoutContainer = Date.now();
  const reportFile = selfCheckFile();
  void app.whenReady().then(() => {
    let report: unknown;
    let exitCode = 1;
    try {
      container = startContainer();
      report = collectSelfCheck(container, {
        packaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        // The product version, not `app.getVersion()`: outside a packaged build the
        // latter reports Electron's own version, which is not what support needs.
        version: APP_VERSION,
      });
      exitCode = (report as { ok: boolean }).ok ? 0 : 1;
    } catch (error) {
      report = {
        app: APP_NAME,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedWithoutContainer,
      };
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(json);
    for (const target of selfCheckWriteTargets(reportFile)) {
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, json, 'utf8');
      } catch (error) {
        process.stdout.write(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    container?.close();
    container = null;
    app.exit(exitCode);
  });
}

function bootstrap(): void {
  app.setAppUserModelId('bd.shohankhan.dentivapro');
  applySecurityPolicy();

  app.on('second-instance', () => focusMainWindow());
  app.on('activate', () => focusMainWindow());

  app.on('before-quit', () => {
    quitting = true;
    if (container) {
      try {
        container.services.app.markShutdown(true);
      } catch {
        // Never block the exit path.
      }
    }
  });

  app.on('will-quit', () => {
    ipcMain.removeHandler(INVOKE_CHANNEL);
    container?.close();
    container = null;
    router = null;
  });

  void app.whenReady().then(async () => {
    const paths = resolveCorePaths();
    const bootLogger = createLogger({
      directory: paths.logsDir,
      minLevel: process.env['DENTIVA_LOG_LEVEL'] === 'debug' ? 'debug' : 'info',
      mirrorToConsole: !app.isPackaged,
    });
    const restoreOutcome = await finishStagedRestore(bootLogger);

    container = startContainer();
    registerIpc();
    buildMenu();
    mainWindow = createWindow();
    startHousekeeping();
    if (restoreOutcome) reportRestoreOutcome(restoreOutcome);
  });
}

if (isSelfCheckRun()) {
  // The self-check never opens a second window and never touches the single
  // instance lock, so it cannot disturb a running clinic session.
  runSelfCheckAndExit();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

/**
 * Application shell state: bootstrap, health and system information.
 *
 * The renderer asks for one bootstrap payload at start-up and switches on
 * `state`: an installation that has not been activated shows the activation
 * screen, an activated but unconfigured one shows the setup wizard, a locked
 * session shows the lock screen, and everything else shows the workspace. That
 * single value is what keeps the shell from ever rendering a screen it cannot
 * leave.
 */
import type { SqliteDatabase } from '../db/connection';
import { checkIntegrity, databaseSizeBytes, hadAbnormalExit, markCleanShutdown, schemaVersion } from '../db/connection';
import type { CoreContext } from '../context';
import type { ActivationStatus, AppBootstrap, AppSettings, AppState, ClinicProfile, HealthReport, SetupStatus, SystemInfo } from '@shared/types';
import { APP_BUILD_NUMBER, APP_VERSION } from '@shared/app-info';
import type { SettingsService } from './settings-service';
import type { SetupService } from './setup-service';

export interface RuntimeInfo {
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly osVersion: string;
  readonly architecture: string;
  readonly locale: string;
}

export class AppService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly ctx: () => CoreContext,
    private readonly settings: SettingsService,
    private readonly setup: SetupService,
    private readonly runtime: () => RuntimeInfo,
  ) {}

  private context(): CoreContext {
    return this.ctx();
  }

  /** Combined state used by the shell to decide which screen to show. */
  state(): AppState {
    const activation = this.setup.activationStatus();
    if (!activation.activated) return 'activation_required';
    if (!this.settings.isSetupComplete()) return 'setup_required';
    const session = this.context().session;
    if (!session.isAuthenticated() || session.isLocked()) return 'locked';
    return 'ready';
  }

  bootstrap(): AppBootstrap {
    const ctx = this.context();
    const state = this.state();
    const session = ctx.session.currentUser();
    const settings = state === 'activation_required' ? null : this.settings.getSettings();
    const clinic = state === 'activation_required' || state === 'setup_required' ? null : this.settings.getClinic();
    const lastBackup = this.db
      .prepare(`SELECT created_at FROM backup_records WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get() as { created_at: string } | undefined;

    return {
      state,
      appVersion: ctx.appVersion,
      appBuild: ctx.appBuild,
      session: state === 'ready' ? session : null,
      clinic,
      settings,
      activation: this.setup.activationStatus(),
      setup: this.settings.getSetupState(),
      dataDir: ctx.paths.dataDir,
      lastBackupAt: lastBackup ? lastBackup.created_at : null,
      previousShutdownWasAbnormal: hadAbnormalExit(this.db),
    };
  }

  health(): HealthReport {
    const ctx = this.context();
    const integrity = checkIntegrity(this.db);
    const attachmentCount = Number(
      (this.db.prepare(`SELECT COUNT(*) AS total FROM attachments WHERE deleted_at IS NULL`).get() as { total: number }).total,
    );
    return {
      databaseOk: this.isDatabaseOpen(),
      integrityOk: integrity.ok,
      schemaVersion: schemaVersion(this.db),
      dataDir: ctx.paths.dataDir,
      logDir: ctx.paths.logsDir,
      attachmentsDir: ctx.paths.attachmentsDir,
      backupsDir: ctx.paths.backupsDir,
      databaseSizeBytes: databaseSizeBytes(this.db),
      attachmentCount,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  systemInfo(): SystemInfo {
    const ctx = this.context();
    const runtime = this.runtime();
    const installedAt = ctx.instant();
    const installed = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'installed_at'`).get() as { value: string } | undefined;
    if (!installed) {
      this.db.prepare(`INSERT INTO app_meta (key, value) VALUES ('installed_at', ?) ON CONFLICT(key) DO NOTHING`).run(installedAt);
    }
    const stored = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'installed_at'`).get() as { value: string } | undefined;
    return {
      appVersion: ctx.appVersion || APP_VERSION,
      appBuild: ctx.appBuild || APP_BUILD_NUMBER,
      electronVersion: runtime.electronVersion,
      chromeVersion: runtime.chromeVersion,
      nodeVersion: runtime.nodeVersion,
      osVersion: runtime.osVersion,
      architecture: runtime.architecture,
      userDataPath: ctx.paths.root,
      databasePath: ctx.paths.databasePath,
      logPath: ctx.paths.logsDir,
      installedAt: stored?.value ?? installedAt,
      locale: runtime.locale,
    };
  }

  /** Settings and clinic snapshot used by the About screen and support. */
  preferences(): { settings: AppSettings; clinic: ClinicProfile; activation: ActivationStatus; setup: SetupStatus } {
    return {
      settings: this.settings.getSettings(),
      clinic: this.settings.getClinic(),
      activation: this.setup.activationStatus(),
      setup: this.settings.getSetupState(),
    };
  }

  private isDatabaseOpen(): boolean {
    try {
      this.db.prepare(`SELECT 1 AS ok`).get();
      return true;
    } catch {
      return false;
    }
  }

  /** Marks a clean shutdown so the next start can tell an abnormal exit apart. */
  markShutdown(clean: boolean): void {
    markCleanShutdown(this.db, clean);
  }
}

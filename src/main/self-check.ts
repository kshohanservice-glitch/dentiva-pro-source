/**
 * Installation self-check.
 *
 * `Dentiva Pro.exe --self-check` opens the clinic database exactly as the
 * application does, runs the integrity checks and prints a single JSON report
 * before exiting. Nothing is written and no window is opened, so it is safe to
 * run on a clinic machine at any time — and it is what the release pipeline
 * runs against the freshly installed application to prove the packaged build
 * can start, find its data directory and open its database.
 *
 * Exit code 0 means the installation is healthy; 1 means it is not, and the
 * report says why.
 */
import { APP_BUILD_NUMBER, APP_NAME, APP_VERSION } from '@shared/app-info';
import type { CoreContainer } from '@core/container';
import type { IsoInstant } from '@shared/dates';
import type { AppState } from '@shared/types';

export interface SelfCheckReport {
  readonly app: string;
  readonly version: string;
  readonly build: number;
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly state: AppState;
  readonly licenceActivated: boolean;
  readonly setupComplete: boolean;
  readonly databaseOk: boolean;
  readonly schemaVersion: number;
  readonly databaseFile: string;
  readonly databaseSizeBytes: number;
  readonly attachmentCount: number;
  readonly integrityOk: boolean;
  readonly foreignKeyViolations: number;
  readonly problems: readonly string[];
  readonly checkedAt: IsoInstant;
  readonly ok: boolean;
  readonly durationMs: number;
}

export interface SelfCheckRuntime {
  readonly packaged: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly version?: string;
  readonly build?: string;
}

/** Gather the report from a live container. Pure: it only reads. */
export function collectSelfCheck(container: CoreContainer, runtime: SelfCheckRuntime): SelfCheckReport {
  const startedAt = Date.now();
  const health = container.services.app.health();
  const integrity = container.services.system.integrityCheckInternal();
  const bootstrap = container.services.app.bootstrap();

  const problems = integrity.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  if (!health.databaseOk) problems.push('The database could not be opened for reading.');
  if (integrity.foreignKeyViolations > 0) {
    problems.push(`${integrity.foreignKeyViolations} foreign-key violation(s) were found.`);
  }

  return {
    app: APP_NAME,
    version: runtime.version ?? APP_VERSION,
    build: Number(runtime.build ?? APP_BUILD_NUMBER),
    packaged: runtime.packaged,
    platform: runtime.platform,
    arch: runtime.arch,
    state: bootstrap.state,
    licenceActivated: bootstrap.activation.activated,
    setupComplete: bootstrap.setup.completedAt !== null,
    databaseOk: health.databaseOk,
    schemaVersion: health.schemaVersion,
    databaseFile: container.paths.databasePath,
    databaseSizeBytes: health.databaseSizeBytes,
    attachmentCount: health.attachmentCount,
    integrityOk: integrity.ok,
    foreignKeyViolations: integrity.foreignKeyViolations,
    problems,
    checkedAt: integrity.checkedAt,
    ok: health.databaseOk && integrity.ok,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * UI harness: the real renderer over the real core.
 *
 * Every UI test renders the actual application component tree against a real
 * container (real SQLite file, real migrations, real services, real zod
 * schemas) through the real IPC router. Only three things are substituted, all
 * of them operating-system edges the sandbox does not have:
 *
 *   - `MainPorts` (file pickers, opening a path, relaunch) — inert stubs;
 *   - the print host — the fake from the integration harness;
 *   - the preload bridge — `tests/ui/bridge.ts`, which speaks the same
 *     envelope the preload script speaks.
 *
 * That means a UI test that clicks "Save" runs the same validation, the same
 * permission checks and the same SQL as the packaged application.
 */
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ApiMethodName, ApiRequest, ApiResponse } from '@shared/api';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, DEFAULT_TIME_ZONE } from '@shared/app-info';
import type { DentistInput } from '@shared/types';
import type { MainPorts } from '@main/ports';
import { createRouter, type IpcRouter } from '@main/ipc/router';
import { App } from '@renderer/app';
import { AppProvider } from '@renderer/state/store';
import { createTestApp, type TestApp } from '../integration/harness';
import { setRouter } from './bridge';

/**
 * The owner password the UI suites use. It deliberately avoids the username and
 * the product name, because the password policy (correctly) refuses those.
 */
export const DEFAULT_PASSWORD = 'Clinic-Secret-2026';

export interface UiApp {
  readonly app: TestApp;
  readonly router: IpcRouter;
  /** Call a method through the router exactly as the renderer would. */
  invoke<K extends ApiMethodName>(method: K, payload?: ApiRequest<K>): Promise<ApiResponse<K>>;
  /** Render the application (providers included) at `route`. */
  renderApp(route?: string): RenderResult;
  /** Record the machine activation (the licence code step) without a user. */
  activateLicense(): void;
  /** Create the owner account directly, for tests that do not use the wizard. */
  createOwner(input?: { username?: string; password?: string; fullName?: string }): Promise<number>;
  /** Finish the seven wizard steps through the router (no UI). */
  completeSetup(options?: {
    clinicName?: string;
    withDentist?: boolean;
    administrator?: { username: string; fullName: string; password: string } | null;
  }): Promise<void>;
  /** The most recent render, when a test needs it. */
  view(): RenderResult;
  readonly user: ReturnType<typeof userEvent.setup>;
  dispose(): void;
}

/** An operating-system port set that records calls instead of performing them. */
export function createFakePorts(): MainPorts & { readonly opened: string[]; readonly relaunches: number } {
  const opened: string[] = [];
  const state = { relaunches: 0 };
  return {
    opened,
    get relaunches() {
      return state.relaunches;
    },
    openPath: async (path) => {
      opened.push(path);
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    relaunch: () => {
      state.relaunches += 1;
    },
    quit: () => undefined,
    pickFiles: async () => [],
    pickFolder: async () => null,
    hasOpenDialog: () => true,
    thumbnail: async () => null,
  };
}

export function createUiApp(options: Parameters<typeof createTestApp>[0] = {}): UiApp {
  const app = createTestApp(options);
  const ports = createFakePorts();
  const router = createRouter({ container: app.container, ports });
  setRouter(router);

  let view: RenderResult | null = null;
  const user = userEvent.setup({ document: window.document, advanceTimers: (ms) => void ms });

  const invoke = async <K extends ApiMethodName>(method: K, payload?: ApiRequest<K>): Promise<ApiResponse<K>> => {
    const result = await router.invoke(method, payload ?? undefined);
    if (!result.ok) {
      throw Object.assign(new Error(result.error.message), { code: result.error.code, fieldErrors: result.error.fieldErrors });
    }
    return result.data as ApiResponse<K>;
  };

  return {
    app,
    router,
    invoke,
    user,
    renderApp(route = '/') {
      view = render(
        <MemoryRouter initialEntries={[route]}>
          <AppProvider>
            <App />
          </AppProvider>
        </MemoryRouter>,
      );
      return view;
    },
    view() {
      if (!view) throw new Error('renderApp() has not run yet.');
      return view;
    },
    activateLicense() {
      app.activateLicense();
    },
    async createOwner(input) {
      return app.bootstrapOwner(input);
    },
    async completeSetup({
      clinicName = 'Smile Dental Care',
      withDentist = true,
      administrator = { username: 'owner', fullName: 'Clinic Owner', password: DEFAULT_PASSWORD },
    } = {}) {
      await invoke('setup.saveClinic', {
        name: clinicName,
        address: '12 Mirpur Road, Dhaka 1205',
        phone: '01711111111',
        email: 'frontdesk@example.com',
        website: '',
        logoSourcePath: null,
      });
      await invoke('setup.saveDentists', {
        dentists: withDentist
          ? [
              {
                name: 'Dr. Ayesha Rahman',
                phone: '01722222222',
                email: '',
                registrationNumber: 'BDS-4471',
                visitingHours: 'Sat–Thu, 5–10 pm',
                isActive: true,
                isDefault: true,
                credentials: [
                  {
                    type: 'qualification',
                    title: 'BDS',
                    institution: 'Dhaka Dental College',
                    year: 2016,
                    sortOrder: 10,
                    showOnPrescription: true,
                  },
                ],
              } satisfies DentistInput,
            ]
          : [],
      });
      await invoke('setup.savePreferences', {
        dateFormat: DEFAULT_DATE_FORMAT,
        timeFormat: DEFAULT_TIME_FORMAT,
        timeZone: DEFAULT_TIME_ZONE,
        numberGrouping: 'international',
        autoLockMinutes: 10,
        backupFolder: app.paths.backupsDir,
        backupIntervalDays: 7,
        defaultPrinterName: 'Microsoft Print to PDF',
      });
      if (administrator) await invoke('setup.createAdministrator', administrator);
      await invoke('setup.complete');
    },
    dispose() {
      app.cleanup();
    },
  };
}

/**
 * A UI application that is activated, set up and signed in — the state almost
 * every screen test starts from. Returns the owner's user id.
 */
export async function createReadyUiApp(
  options: Parameters<typeof createTestApp>[0] = {},
  { clinicName = 'Smile Dental Care', route = '/', signIn = true } = {},
): Promise<UiApp & { readonly ownerId: number }> {
  const uiApp = createUiApp(options);
  uiApp.activateLicense();
  await uiApp.completeSetup({ clinicName });
  if (signIn) await uiApp.invoke('auth.login', { username: 'owner', password: DEFAULT_PASSWORD });
  uiApp.renderApp(route);
  const ownerId = (await uiApp.invoke('auth.session'))?.id ?? 0;
  return Object.assign(uiApp, { ownerId });
}

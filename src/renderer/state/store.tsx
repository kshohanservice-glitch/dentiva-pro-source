/**
 * Application state for the renderer.
 *
 * Three concerns live here and nowhere else:
 *   1. the bootstrap/session snapshot (who is signed in, is the app activated,
 *      which clinic is this, which settings apply),
 *   2. operational feedback (toasts, confirmations, block errors),
 *   3. a tiny data-fetching hook so screens do not each reinvent loading and
 *      error handling.
 *
 * The renderer is a pure presentation layer: every mutation goes through
 * `bridge.invoke` and is authorised again inside the core.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApiMethodName, ApiRequest, ApiResponse } from '@shared/api';
import type { AppBootstrap, AppSettings, AppState, ClinicProfile, SessionUser } from '@shared/types';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, DEFAULT_TIME_ZONE } from '@shared/app-info';
import { apiErrorCode, apiErrorMessage, apiFieldErrors, bridge } from '@renderer/lib/bridge';
import { configureFormatters } from '@renderer/lib/format';

// ---------------------------------------------------------------------------
// Toasts & confirmations
// ---------------------------------------------------------------------------

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly body?: string;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly tone: 'default' | 'danger';
  readonly /** Ask for a typed word before the action is allowed. */ typedWord?: string;
  readonly reason?: boolean;
}

interface ConfirmState extends ConfirmRequest {
  readonly resolve: (value: { ok: boolean; typed?: string; reason?: string }) => void;
}

export interface FieldIssue {
  readonly message: string;
  readonly fields: Record<string, string>;
}

interface AppContextValue {
  readonly ready: boolean;
  readonly fatal: string | null;
  readonly state: AppState;
  readonly session: SessionUser | null;
  readonly clinic: ClinicProfile | null;
  readonly settings: AppSettings | null;
  readonly bootstrap: AppBootstrap | null;
  readonly bootstrappedAt: string | null;
  refresh(): Promise<void>;
  applySession(user: SessionUser | null): void;
  toasts: readonly Toast[];
  toast(tone: ToastTone, title: string, body?: string): void;
  dismissToast(id: number): void;
  confirm(request: ConfirmRequest): Promise<{ ok: boolean; typed?: string; reason?: string }>;
  confirmState: ConfirmState | null;
  resolveConfirm(value: { ok: boolean; typed?: string; reason?: string }): void;
  fieldIssues: FieldIssue | null;
  reportFieldIssues(error: unknown): void;
  clearFieldIssues(): void;
  signIn(username: string, password: string): Promise<SessionUser>;
  signOut(): Promise<void>;
  lock(): Promise<void>;
  unlock(password: string): Promise<SessionUser>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

let toastSequence = 0;

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [clinic, setClinic] = useState<ClinicProfile | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [bootstrappedAt, setBootstrappedAt] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [fieldIssues, setFieldIssues] = useState<FieldIssue | null>(null);
  const ready = bootstrap !== null;

  const toast = useCallback((tone: ToastTone, title: string, body?: string) => {
    toastSequence += 1;
    const id = toastSequence;
    setToasts((current) => [...current.slice(-3), { id, tone, title, body }]);
    const timeout = tone === 'error' ? 9000 : 5000;
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), timeout);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<{ ok: boolean; typed?: string; reason?: string }>((resolve) => {
        setConfirmState({ ...request, resolve });
      }),
    [],
  );

  const resolveConfirm = useCallback((value: { ok: boolean; typed?: string; reason?: string }) => {
    setConfirmState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const reportFieldIssues = useCallback((error: unknown) => {
    setFieldIssues({ message: apiErrorMessage(error), fields: apiFieldErrors(error) ?? {} });
  }, []);

  const applyBootstrap = useCallback((next: AppBootstrap) => {
    setBootstrap(next);
    setSession(next.session);
    setClinic(next.clinic);
    setSettings(next.settings);
    setBootstrappedAt(new Date().toISOString());
    configureFormatters({
      datePattern: next.settings?.dateFormat ?? DEFAULT_DATE_FORMAT,
      timePattern: next.settings?.timeFormat ?? DEFAULT_TIME_FORMAT,
      timeZone: next.settings?.timeZone ?? DEFAULT_TIME_ZONE,
      grouping: next.settings?.numberGrouping ?? 'international',
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await bridge.invoke('app.bootstrap');
      applyBootstrap(next);
      setFatal(null);
    } catch (error) {
      setFatal(apiErrorMessage(error));
    }
  }, [applyBootstrap]);

  const applySession = useCallback((user: SessionUser | null) => {
    setSession(user);
    setBootstrap((current) => (current ? { ...current, session: user, state: user ? 'ready' : current.state } : current));
  }, []);

  // Load the snapshot once, then subscribe to everything the main process
  // broadcasts. A locked session must never leave a stale profile on screen.
  useEffect(() => {
    void refresh();
    const unsubscribeState = bridge.on('app.state.changed', () => void refresh());
    const unsubscribeSession = bridge.on('session.changed', (payload) => applySession(payload.session));
    const unsubscribeLocked = bridge.on('session.locked', () => {
      setSession((current) => (current ? { ...current } : null));
      setBootstrap((current) => (current ? { ...current, state: 'locked' } : current));
    });
    const unsubscribeUnlocked = bridge.on('session.unlocked', () => void refresh());
    const unsubscribeRestore = bridge.on('restore.relaunching', (payload) => toast('warning', 'Restoring a backup', payload.message));
    return () => {
      unsubscribeState();
      unsubscribeSession();
      unsubscribeLocked();
      unsubscribeUnlocked();
      unsubscribeRestore();
    };
  }, [applySession, refresh, toast]);

  // Theme + density are applied to the document element so the design tokens
  // cascade everywhere, including portalled dialogs.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings?.theme ?? 'light';
    root.dataset.density = settings?.density ?? 'comfortable';
    root.style.colorScheme = settings?.theme === 'dark' ? 'dark' : 'light';
  }, [settings?.density, settings?.theme]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const user = await bridge.invoke('auth.login', { username, password });
      applySession(user);
      await refresh();
      return user;
    },
    [applySession, refresh],
  );

  const signOut = useCallback(async () => {
    await bridge.invoke('auth.logout');
    applySession(null);
    await refresh();
  }, [applySession, refresh]);

  const lock = useCallback(async () => {
    await bridge.invoke('auth.lock');
    setBootstrap((current) => (current ? { ...current, state: 'locked' } : current));
  }, []);

  const unlock = useCallback(
    async (password: string) => {
      const user = await bridge.invoke('auth.unlock', { password });
      applySession(user);
      await refresh();
      return user;
    },
    [applySession, refresh],
  );

  const value: AppContextValue = useMemo(
    () => ({
      ready,
      fatal,
      state: bootstrap?.state ?? 'activation_required',
      session,
      clinic,
      settings,
      bootstrap,
      bootstrappedAt,
      refresh,
      applySession,
      toasts,
      toast,
      dismissToast,
      confirm,
      confirmState,
      resolveConfirm,
      fieldIssues,
      reportFieldIssues,
      clearFieldIssues: () => setFieldIssues(null),
      signIn,
      signOut,
      lock,
      unlock,
    }),
    [
      bootstrappedAt,
      bootstrap,
      clinic,
      confirm,
      confirmState,
      fieldIssues,
      fatal,
      lock,
      ready,
      refresh,
      applySession,
      reportFieldIssues,
      resolveConfirm,
      session,
      settings,
      signIn,
      signOut,
      toast,
      toasts,
      unlock,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

export interface ApiQueryResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly setData: (value: T | null) => void;
}

/**
 * Run a read-only API method. `deps` follows the usual rules of `useEffect`;
 * pass `null` as the payload to keep the query disabled (for example while a
 * dialog is closed).
 */
export function useApi<K extends ApiMethodName>(
  method: K,
  payload: ApiRequest<K> | null,
  deps: readonly unknown[] = [],
): ApiQueryResult<ApiResponse<K>> {
  const [data, setData] = useState<ApiResponse<K> | null>(null);
  const [loading, setLoading] = useState(payload !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // `null` disables the query; `undefined` means "call this method with no
  // payload at all" (app.bootstrap, setup.status, notifications.unreadCount…).
  const enabled = payload !== null;
  const serialized = enabled ? JSON.stringify(payload ?? null) : '';

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // The payload is re-read from the serialised dependency so the effect does
    // not re-run for an object with the same contents.
    const request = payload === undefined ? undefined : (JSON.parse(serialized) as ApiRequest<K>);
    bridge
      .invoke(method, request)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(apiErrorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, serialized, enabled, nonce, ...deps]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, loading, error, reload, setData };
}

/** Imperative action helper with unified error reporting and toasts. */
export interface ActionRunner {
  /**
   * Run an action. Returns the value the action produced, or `null` when it
   * failed (a toast is shown either way).
   */
  run<T>(work: () => Promise<T>, options?: { success?: string; failure?: string }): Promise<T | null>;
  /**
   * Run an action and report only *whether it succeeded*. This is the correct
   * branch for methods whose result is `undefined` — checking `run(…) !==
   * undefined` can never be true for them, so follow-up work (closing a dialog,
   * advancing the wizard) would silently never happen.
   */
  runOk(work: () => Promise<unknown>, options?: { success?: string; failure?: string }): Promise<boolean>;
  busy: boolean;
}

export function useAction(): ActionRunner {
  const { toast, reportFieldIssues } = useApp();
  const [busy, setBusy] = useState(false);
  const attempt = useCallback(
    async <T,>(
      work: () => Promise<T>,
      options: { success?: string; failure?: string },
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      setBusy(true);
      try {
        const value = await work();
        if (options.success) toast('success', options.success);
        return { ok: true, value };
      } catch (error) {
        const code = apiErrorCode(error);
        if (code === 'VALIDATION') reportFieldIssues(error);
        toast('error', options.failure ?? 'The action could not be completed.', apiErrorMessage(error));
        return { ok: false };
      } finally {
        setBusy(false);
      }
    },
    [reportFieldIssues, toast],
  );
  const run = useCallback(
    async <T,>(work: () => Promise<T>, options: { success?: string; failure?: string } = {}): Promise<T | null> => {
      const result = await attempt(work, options);
      return result.ok ? result.value : null;
    },
    [attempt],
  );
  const runOk = useCallback(
    async (work: () => Promise<unknown>, options: { success?: string; failure?: string } = {}): Promise<boolean> => {
      return (await attempt(work, options)).ok;
    },
    [attempt],
  );
  return { run, runOk, busy };
}

/** Re-run a callback whenever the window regains focus (fresh lists). */
export function useRefreshOnFocus(callback: () => void, enabled = true): void {
  const reference = useRef(callback);
  reference.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const handler = () => reference.current();
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [enabled]);
}

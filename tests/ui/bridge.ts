/**
 * The renderer's view of `window.dentiva`, wired to a real router.
 *
 * The tests install this bridge *before* the renderer modules are imported, so
 * `@renderer/lib/bridge` binds to it exactly as it binds to the preload bridge
 * in the packaged application. `setRouter` swaps the router between tests;
 * `emit` lets a test play the part of the main process when it broadcasts.
 */
import type { BridgeEventName, BridgeEventPayloads, BridgeInvokeResult, DentivaBridge } from '@shared/api';
import { APP_BUILD_NUMBER, APP_VERSION } from '@shared/app-info';
import type { IpcRouter } from '@main/ipc/router';

type Listener = (payload: unknown) => void;

let router: IpcRouter | null = null;
const listeners = new Map<string, Set<Listener>>();

/** Point the bridge at a router (or away from one, between tests). */
export function setRouter(next: IpcRouter | null): void {
  router = next;
}

/** Broadcast an event the way the main process does. */
export function emit<E extends BridgeEventName>(event: E, payload: BridgeEventPayloads[E]): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

const bridge: DentivaBridge & { pathForFile(file: File): string } = {
  isElectron: true,
  versions: { app: APP_VERSION, build: APP_BUILD_NUMBER, electron: '39.8.10', node: '22.22.3', chrome: '142.0.0.0' },
  pathForFile: (file: File) => file.name,
  async invoke(method, payload) {
    if (!router) throw Object.assign(new Error('No router is installed for this test.'), { code: 'UNKNOWN' });
    const result: BridgeInvokeResult<unknown> = await router.invoke(method, payload);
    if (!result.ok) {
      // Exactly what the preload script throws, so screens see the real code
      // and the real per-field messages.
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
        fieldErrors: result.error.fieldErrors,
      });
    }
    return result.data as never;
  },
  on(event, listener) {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener as Listener);
    listeners.set(event, set);
    return () => {
      set.delete(listener as Listener);
    };
  },
};

export function installBridge(): void {
  listeners.clear();
  Object.defineProperty(window, 'dentiva', { configurable: true, writable: true, value: bridge });
}

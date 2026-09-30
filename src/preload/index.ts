/**
 * The only bridge between the renderer and the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer only
 * ever sees these five functions. `invoke` carries `(method, payload)` to the
 * router, which validates it against the zod schema for that method; `on`
 * subscribes to the small set of events the main process broadcasts and
 * returns an unsubscribe function.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ApiMethodName, ApiRequest, ApiResponse, BridgeEventName, BridgeEventPayloads, BridgeInvokeResult, DentivaBridge } from '@shared/api';

const INVOKE_CHANNEL = 'dentiva:invoke';
const EVENT_CHANNEL = 'dentiva:event';

interface EventMessage {
  name: BridgeEventName;
  payload: unknown;
}

const bridge: DentivaBridge & { pathForFile(file: File): string } = {
  isElectron: true,
  versions: {
    app: process.env['DENTIVA_APP_VERSION'] ?? '',
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },
  invoke<K extends ApiMethodName>(method: K, payload?: ApiRequest<K>): Promise<ApiResponse<K>> {
    return ipcRenderer
      .invoke(INVOKE_CHANNEL, method, payload)
      .then((result: BridgeInvokeResult<ApiResponse<K>>) => {
        if (!result || typeof result !== 'object') {
          throw Object.assign(new Error('The application did not answer.'), { code: 'UNKNOWN' });
        }
        if (result.ok) return result.data;
        const error = Object.assign(new Error(result.error.message), {
          code: result.error.code,
          fieldErrors: result.error.fieldErrors,
        });
        throw error;
      });
  },
  on<E extends BridgeEventName>(event: E, listener: (payload: BridgeEventPayloads[E]) => void): () => void {
    const handler = (_event: unknown, message: EventMessage): void => {
      if (message && message.name === event) {
        listener(message.payload as BridgeEventPayloads[E]);
      }
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, handler);
    };
  },
  /**
   * Absolute path of a dropped file. Electron 32 removed `File.path`, so the
   * renderer asks the preload instead of guessing.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('dentiva', bridge);

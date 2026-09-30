/**
 * The single door between the renderer and the domain.
 *
 * Every call is (1) checked against the method list, (2) validated by zod,
 * (3) executed against the live session (the services enforce permissions
 * themselves — the UI hiding a button is never the only guard), and (4) wrapped
 * in the envelope the preload bridge unwraps.
 */
import type { ApiMethodName, BridgeInvokeResult } from '@shared/api';
import { API_METHOD_NAMES } from '@shared/api';
import { AppError, describeUnknown, serializeError } from '@shared/errors';
import type { CoreContainer } from '@core/container';
import { SCHEMAS } from './schemas';
import { createHandlers, type HandlerContext } from './handlers';
import type { MainPorts } from '../ports';

export interface IpcRouter {
  readonly methods: readonly ApiMethodName[];
  invoke(method: string, payload: unknown): Promise<BridgeInvokeResult<unknown>>;
}

const VALIDATION_MESSAGE = 'Some of the details sent to the application were not valid.';

export interface RouterOptions {
  readonly container: CoreContainer;
  readonly ports: MainPorts;
}

export function createRouter({ container, ports }: RouterOptions): IpcRouter {
  const context: HandlerContext = { container, ports };
  const handlers = createHandlers();
  const known = new Set<string>(API_METHOD_NAMES);

  return {
    methods: API_METHOD_NAMES,
    async invoke(method: string, payload: unknown): Promise<BridgeInvokeResult<unknown>> {
      if (!known.has(method) || !Object.prototype.hasOwnProperty.call(handlers, method)) {
        return { ok: false, error: { code: 'VALIDATION', message: `Unknown method “${method}”.` } };
      }
      const schema = SCHEMAS[method as ApiMethodName];
      const parsed = schema.safeParse(payload ?? undefined);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'VALIDATION', message: VALIDATION_MESSAGE, fieldErrors: fieldErrorsFrom(parsed.error.issues) },
        };
      }
      try {
        const data = await handlers[method as ApiMethodName](parsed.data, context);
        return { ok: true, data };
      } catch (error) {
        if (error instanceof AppError) return { ok: false, error: serializeError(error) };
        container.logger.error(`IPC ${method} failed: ${describeUnknown(error)}`);
        return { ok: false, error: serializeError(error) };
      }
    },
  };
}

function fieldErrorsFrom(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map((part) => String(part)).join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

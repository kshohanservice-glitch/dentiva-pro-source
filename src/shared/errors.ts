/**
 * Error model shared by the core services, the IPC router and the renderer.
 *
 * Every error that crosses the process boundary carries a stable machine code
 * and a message that is safe to display to a clinic user. Technical detail is
 * retained locally for the log file and never shown in the UI.
 */
export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'LOCKED'
  | 'RATE_LIMITED'
  | 'PRECONDITION_FAILED'
  | 'INTEGRITY'
  | 'IO'
  | 'ACTIVATION_REQUIRED'
  | 'SETUP_REQUIRED'
  | 'PRINT_FAILED'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

export interface AppErrorShape {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly detail?: string;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Record<string, string>;
  readonly detail?: string;

  constructor(code: AppErrorCode, message: string, options: { fieldErrors?: Record<string, string>; detail?: string } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (options.fieldErrors) this.fieldErrors = options.fieldErrors;
    if (options.detail) this.detail = options.detail;
  }

  toShape(): AppErrorShape {
    const shape: {
      code: AppErrorCode;
      message: string;
      fieldErrors?: Record<string, string>;
      detail?: string;
    } = { code: this.code, message: this.message };
    if (this.fieldErrors) shape.fieldErrors = this.fieldErrors;
    if (this.detail) shape.detail = this.detail;
    return shape;
  }

  static validation(message: string, fieldErrors?: Record<string, string>): AppError {
    return new AppError('VALIDATION', message, fieldErrors ? { fieldErrors } : {});
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', `${what} could not be found. It may have been removed.`);
  }

  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static unauthenticated(message = 'Your session has ended. Please sign in again.'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static locked(message = 'The application is locked. Please sign in to continue.'): AppError {
    return new AppError('LOCKED', message);
  }

  static rateLimited(message: string, retryAfterMinutes?: number): AppError {
    return new AppError('RATE_LIMITED', message, retryAfterMinutes === undefined ? {} : { detail: `retry-after:${retryAfterMinutes}m` });
  }

  static precondition(message: string): AppError {
    return new AppError('PRECONDITION_FAILED', message);
  }

  static integrity(message: string, detail?: string): AppError {
    return new AppError('INTEGRITY', message, detail ? { detail } : {});
  }

  static io(message: string, detail?: string): AppError {
    return new AppError('IO', message, detail ? { detail } : {});
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export interface SerializedError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly fieldErrors?: Record<string, string>;
}

/**
 * Normalise anything thrown into the serialisable error shape used on the wire.
 * Unknown errors are reported generically so internal details never leak into
 * the user interface; the original is returned in `detail` for local logging.
 */
export function serializeError(error: unknown): SerializedError {
  if (isAppError(error)) {
    return error.fieldErrors
      ? { code: error.code, message: error.message, fieldErrors: error.fieldErrors }
      : { code: error.code, message: error.message };
  }
  return { code: 'UNKNOWN', message: 'Something went wrong. Please try again, or check the log file for details.' };
}

export function describeUnknown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean };
}

interface AppErrorOptions {
  code: string;
  status: number;
  retryable: boolean;
  cause?: unknown;
}

/** An error with a message that is safe to show a user. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
  }

  toJSON(): ErrorBody {
    return {
      error: { code: this.code, message: this.message, retryable: this.retryable },
    };
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, { code: "bad_request", status: 400, retryable: false });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "That endpoint does not exist.") {
    super(message, { code: "not_found", status: 404, retryable: false });
  }
}

/** The model server could not be reached or has nothing usable installed. */
export class ProviderUnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "provider_unavailable", status: 503, retryable: true, cause });
  }
}

/** The model server answered, but with a failure or an unusable response. */
export class UpstreamError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "upstream_error", status: 502, retryable: true, cause });
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Narrow anything thrown into an AppError with a friendly message. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (isAbortError(error)) {
    return new AppError("The request was cancelled.", {
      code: "cancelled",
      status: 499,
      retryable: true,
      cause: error,
    });
  }
  return new AppError("Something went wrong on the server.", {
    code: "internal_error",
    status: 500,
    retryable: true,
    cause: error,
  });
}

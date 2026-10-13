type Level = "info" | "warn" | "error";

function write(level: Level, message: string, meta?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${level.toUpperCase()} ${message}`;
  const out = meta && Object.keys(meta).length > 0 ? `${line} ${JSON.stringify(meta)}` : line;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

/**
 * Minimal logger. Callers must not pass secrets: nothing here attempts to
 * redact values, so keep API keys out of `meta` entirely.
 */
export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};

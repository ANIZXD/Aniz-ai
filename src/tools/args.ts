/** Raised when a tool argument is missing or the wrong type. */
export class BadArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadArgsError";
  }
}

function raw(args: Record<string, unknown>, name: string): unknown {
  return args === null || typeof args !== "object" ? undefined : args[name];
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = raw(args, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadArgsError(`"${name}" is required and must be a non-empty string.`);
  }
  return value;
}

export function requireStringAllowEmpty(args: Record<string, unknown>, name: string): string {
  const value = raw(args, name);
  if (typeof value !== "string") {
    throw new BadArgsError(`"${name}" is required and must be a string.`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = raw(args, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadArgsError(`"${name}" must be a string.`);
  return value;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = raw(args, name);
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  // Small models often send "true"/"false" as strings.
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadArgsError(`"${name}" must be true or false.`);
}

export function optionalNumber(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw(args, name);
  if (value === undefined || value === null || value === "") return fallback;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new BadArgsError(`"${name}" must be a number.`);
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

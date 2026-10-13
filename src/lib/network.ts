/**
 * Collects connection details from an error chain.
 *
 * `fetch` failures rarely carry the useful part on the top-level error: undici
 * reports `TypeError("fetch failed")` whose `cause` is often an AggregateError
 * holding the real per-address errors. Walk the chain (and AggregateError's
 * `errors`) to find codes like ECONNREFUSED.
 */
export function networkDetail(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }

    if (value instanceof Error) {
      if (value.message !== "") parts.push(value.message);

      const code = (value as NodeJS.ErrnoException).code;
      if (typeof code === "string" && code !== "") parts.push(code);

      const aggregated = (value as { errors?: unknown }).errors;
      if (Array.isArray(aggregated)) visit(aggregated, depth + 1);

      if (value.cause !== undefined) visit(value.cause, depth + 1);
    }
  };

  visit(error, 0);
  return parts.join(" | ");
}

/** True when the detail looks like "nothing is listening on that address". */
export function looksLikeConnectionRefused(detail: string): boolean {
  return /ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(
    detail,
  );
}

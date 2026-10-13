export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * True while the model's output could still turn out to be a tool call. The
 * protocol requires a tool call to be the entire reply, so anything starting
 * with `{` or a code fence stays withheld until the reply is complete.
 */
export function looksUndecided(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed === "") return true;
  return trimmed.startsWith("{") || trimmed.startsWith("```");
}

/** Returns the first balanced {...} object in `source`, ignoring strings. */
function extractJsonObject(source: string): string | null {
  const start = source.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

/**
 * Parses a tool call out of a model reply. Accepts a bare object or one wrapped
 * in a code fence, and tolerates `name`/`arguments` as aliases.
 */
export function parseToolCall(text: string): ToolCall | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const source = fenced?.[1] ?? text;

  const candidate = extractJsonObject(source);
  if (candidate === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const rawName = record.tool ?? record.name;
  if (typeof rawName !== "string" || rawName.trim() === "") return null;

  const rawArgs = record.args ?? record.arguments ?? {};
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) return null;

  return { name: rawName.trim(), args: rawArgs as Record<string, unknown> };
}

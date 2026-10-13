export type StoredRole = "user" | "assistant" | "tool";

export interface StoredMessage {
  id: string;
  role: StoredRole;
  content: string;
  /** Set on `tool` messages: which tool produced this result. */
  toolName?: string;
  /** Set on `tool` messages: whether the tool call succeeded. */
  ok?: boolean;
  createdAt: string;
}

export interface Session {
  id: string;
  /** Empty until the first user message names it. */
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Keeps a small local model responsive by bounding what it has to read. */
export const MAX_CONTEXT_MESSAGES = 40;

export function titleFromMessage(content: string): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (compact === "") return "";
  return compact.length <= 48 ? compact : `${compact.slice(0, 47).trimEnd()}…`;
}

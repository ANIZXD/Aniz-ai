import { randomUUID } from "node:crypto";
import { createJsonFile } from "../lib/fsjson.ts";
import { titleFromMessage } from "./types.ts";
import type { Session, SessionSummary, StoredMessage, StoredRole } from "./types.ts";

interface DataFile {
  version: number;
  sessions: Session[];
}

export interface AppendInput {
  role: StoredRole;
  content: string;
  toolName?: string;
  ok?: boolean;
}

export interface SessionStore {
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<Session | null>;
  create(title?: string): Promise<Session>;
  append(id: string, input: AppendInput): Promise<Session | null>;
  rename(id: string, title: string): Promise<Session | null>;
  remove(id: string): Promise<boolean>;
}

const EMPTY: DataFile = { version: 1, sessions: [] };

function summarize(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function createSessionStore(filePath: string): SessionStore {
  const file = createJsonFile<DataFile>(filePath, () => ({ ...EMPTY, sessions: [] }));

  // Read-modify-write cycles must not interleave, so they queue here. The
  // underlying file writes are serialized too, but that alone is not enough.
  let chain: Promise<unknown> = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async list(): Promise<SessionSummary[]> {
      const data = await file.read();
      return data.sessions
        .map(summarize)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async get(id: string): Promise<Session | null> {
      const data = await file.read();
      return data.sessions.find((session) => session.id === id) ?? null;
    },

    create(title = ""): Promise<Session> {
      return mutate(async () => {
        const data = await file.read();
        const now = new Date().toISOString();
        const session: Session = {
          id: randomUUID(),
          title: title.trim(),
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        data.sessions.push(session);
        await file.write(data);
        return session;
      });
    },

    append(id: string, input: AppendInput): Promise<Session | null> {
      return mutate(async () => {
        const data = await file.read();
        const session = data.sessions.find((entry) => entry.id === id);
        if (!session) return null;

        const message: StoredMessage = {
          id: randomUUID(),
          role: input.role,
          content: input.content,
          createdAt: new Date().toISOString(),
          ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
          ...(input.ok === undefined ? {} : { ok: input.ok }),
        };
        session.messages.push(message);

        // Name the session after its first user message.
        if (session.title === "" && input.role === "user") {
          session.title = titleFromMessage(input.content);
        }

        session.updatedAt = message.createdAt;
        await file.write(data);
        return session;
      });
    },

    rename(id: string, title: string): Promise<Session | null> {
      return mutate(async () => {
        const data = await file.read();
        const session = data.sessions.find((entry) => entry.id === id);
        if (!session) return null;
        session.title = title.trim();
        session.updatedAt = new Date().toISOString();
        await file.write(data);
        return session;
      });
    },

    remove(id: string): Promise<boolean> {
      return mutate(async () => {
        const data = await file.read();
        const index = data.sessions.findIndex((entry) => entry.id === id);
        if (index === -1) return false;
        data.sessions.splice(index, 1);
        await file.write(data);
        return true;
      });
    },
  };
}

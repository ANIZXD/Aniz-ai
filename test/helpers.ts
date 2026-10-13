import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type AppOptions } from "../src/app.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import type { ChatMessage, ChatUsage, ProviderAdapter, StreamEvent } from "../src/providers/types.ts";

/** A slice of a config pointed at a throwaway directory. */
export function tempConfig(dir: string): AppConfig {
  return {
    ...loadConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, "workspace"),
    sessionsFile: path.join(dir, "sessions.json"),
  };
}

/**
 * Runs `run` against a real server backed by a temporary data directory, so
 * tests never touch the developer's own conversations or workspace.
 */
export async function withTempServer(
  options: AppOptions,
  run: (baseUrl: string, config: AppConfig) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "anizai-test-"));
  const config = tempConfig(dir);
  await mkdir(config.workspaceDir, { recursive: true });

  const app = createApp(config, options);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, config);
  } finally {
    server.close();
    await once(server, "close");
    await rm(dir, { recursive: true, force: true });
  }
}

export interface TempServer {
  baseUrl: string;
  dir: string;
  config: AppConfig;
}

/** Same as withTempServer, but hands the caller the temp directory too. */
export async function withTempDir(
  options: AppOptions,
  run: (server: TempServer) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "anizai-test-"));
  const config = tempConfig(dir);
  await mkdir(config.workspaceDir, { recursive: true });

  const app = createApp(config, options);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;
  try {
    await run({ baseUrl: `http://127.0.0.1:${port}`, dir, config });
  } finally {
    server.close();
    await once(server, "close");
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parses a complete Server-Sent Events body into structured events. */
export async function readSse(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];

  for (const frame of text.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];

    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }

    if (dataLines.length === 0) continue;
    events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
  }

  return events;
}

export function postChat(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deltasOf(events: SseEvent[]): string {
  return events
    .filter((entry) => entry.event === "delta")
    .map((entry) => String(entry.data.text ?? ""))
    .join("");
}

export function eventsNamed(events: SseEvent[], name: string): SseEvent[] {
  return events.filter((entry) => entry.event === name);
}

function chunk(text: string, size: number): string[] {
  if (text === "") return [""];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size));
  }
  return parts;
}

export interface ScriptedAdapter extends ProviderAdapter {
  /** The exact messages handed to each successive call. */
  readonly calls: ChatMessage[][];
}

/**
 * A provider that replies with a fixed script, one entry per call. Lets tests
 * drive a multi-step agent loop deterministically, with no network.
 */
export function createScriptedAdapter(turns: string[]): ScriptedAdapter {
  const calls: ChatMessage[][] = [];
  let index = 0;

  return {
    id: "scripted",
    kind: "test",
    label: "Scripted provider",
    defaultModel: "scripted",
    calls,

    isAvailable: async () => ({ ok: true, detail: "Ready.", models: ["scripted"] }),
    listModels: async () => ["scripted"],

    async *streamChat(request): AsyncGenerator<StreamEvent> {
      calls.push(request.messages.map((message) => ({ ...message })));
      const callNumber = calls.length;

      const text = turns[index] ?? "";
      index += 1;

      for (const part of chunk(text, 5)) {
        yield { type: "delta", text: part };
      }

      // Usage varies per call so tests can tell one turn's usage from another's.
      const usage: ChatUsage = { promptTokens: callNumber, completionTokens: callNumber };
      yield { type: "done", model: "scripted", finishReason: "stop", producedText: text !== "", usage };
    },
  };
}

export { assert };

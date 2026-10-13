import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ProviderUnavailableError } from "../src/errors.ts";
import { createMockAdapter } from "../src/providers/mock.ts";
import type { ProviderAdapter, StreamEvent } from "../src/providers/types.ts";
import {
  deltasOf,
  eventsNamed,
  postChat,
  readSse,
  withTempServer,
} from "./helpers.ts";

const provider = createMockAdapter();

describe("POST /api/chat (chat mode)", () => {
  test("streams meta, delta and done events for a message", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

      const events = await readSse(response);
      const meta = eventsNamed(events, "meta")[0];
      assert.equal(meta?.data.provider, "mock");
      assert.equal(meta?.data.mode, "chat");
      assert.equal(typeof meta?.data.sessionId, "string");

      assert.match(deltasOf(events), /hello/);

      const done = eventsNamed(events, "done")[0];
      assert.equal(done?.data.finishReason, "stop");
      assert.equal(done?.data.steps, 1);
      assert.equal(done?.data.sessionId, meta?.data.sessionId);
    });
  });

  test("accepts a full messages array without storing it", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "second" },
        ],
      });

      assert.equal(response.status, 200);
      const events = await readSse(response);
      assert.match(deltasOf(events), /second/);

      // The stateless form must not create a conversation.
      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
        sessions: unknown[];
      };
      assert.equal(list.sessions.length, 0);
    });
  });

  test("rejects an empty body with a friendly 400", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, {});
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.equal(body.error.code, "bad_request");
      assert.match(body.error.message, /'message' or 'messages'/);
    });
  });

  test("rejects a blank message", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, {
        messages: [{ role: "user", content: "   " }],
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /cannot be empty/);
    });
  });

  test("rejects an unknown role", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, { messages: [{ role: "wizard", content: "hi" }] });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /role/);
    });
  });

  test("rejects an unknown mode", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, { message: "hi", mode: "telepathy" });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /mode/);
    });
  });

  test("reports a broken JSON body as a 400", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "bad_request");
    });
  });

  test("turns a provider failure into an error event, not a crash", async () => {
    const broken: ProviderAdapter = {
      id: "broken",
      kind: "local",
      label: "Broken provider",
      defaultModel: "none",
      isAvailable: async () => ({ ok: false, detail: "down" }),
      listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new ProviderUnavailableError(
          "Cannot reach the local model. Make sure Ollama is running.",
        );
      },
    };

    await withTempServer({ provider: broken, providers: [broken] }, async (baseUrl) => {
      const response = await postChat(baseUrl, { message: "hi" });
      assert.equal(response.status, 200);

      const events = await readSse(response);
      const error = eventsNamed(events, "error")[0];
      assert.equal(error?.data.code, "provider_unavailable");
      assert.match(String(error?.data.message), /Make sure Ollama is running/);
    });
  });
});

describe("conversation persistence", () => {
  test("stores the user and assistant messages and lists the conversation", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const events = await readSse(
        await postChat(baseUrl, { message: "Remember this question" }),
      );
      const sessionId = String(eventsNamed(events, "meta")[0]?.data.sessionId);

      const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as {
        sessions: Array<{ id: string; title: string; messageCount: number }>;
      };
      assert.equal(list.sessions.length, 1);
      assert.equal(list.sessions[0]?.id, sessionId);
      assert.equal(list.sessions[0]?.title, "Remember this question");
      assert.equal(list.sessions[0]?.messageCount, 2);

      const detail = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
        session: { messages: Array<{ role: string; content: string }> };
      };
      assert.equal(detail.session.messages[0]?.role, "user");
      assert.equal(detail.session.messages[1]?.role, "assistant");
    });
  });

  test("continues an existing conversation and replays its history", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const first = await readSse(await postChat(baseUrl, { message: "first question" }));
      const sessionId = String(eventsNamed(first, "meta")[0]?.data.sessionId);

      const second = await readSse(
        await postChat(baseUrl, { message: "second question", sessionId }),
      );

      // The mock echoes the last user message it receives.
      assert.match(deltasOf(second), /second question/);
      assert.equal(eventsNamed(second, "meta")[0]?.data.sessionId, sessionId);

      const detail = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
        session: { messages: Array<{ role: string; content: string }> };
      };
      assert.equal(detail.session.messages.length, 4);
      assert.equal(detail.session.messages[2]?.content, "second question");
    });
  });

  test("retry re-runs the last message without storing it twice", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const first = await readSse(await postChat(baseUrl, { message: "please retry me" }));
      const sessionId = String(eventsNamed(first, "meta")[0]?.data.sessionId);

      const retried = await readSse(await postChat(baseUrl, { retry: true, sessionId }));
      assert.equal(eventsNamed(retried, "meta")[0]?.data.sessionId, sessionId);

      const detail = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
        session: { messages: Array<{ role: string; content: string }> };
      };
      const userMessages = detail.session.messages.filter((message) => message.role === "user");
      assert.equal(userMessages.length, 1, "the user message must not be duplicated");
      assert.equal(detail.session.messages.length, 3, "user, assistant, assistant");
    });
  });

  test("retry without a session id is a 400", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, { retry: true });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /sessionId/);
    });
  });

  test("chatting to an unknown conversation is a 404", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await postChat(baseUrl, { message: "hi", sessionId: "nope" });
      assert.equal(response.status, 404);
    });
  });
});

describe("session routes", () => {
  test("support create, rename and delete", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Named up front" }),
        })
      ).json()) as { session: { id: string; title: string } };

      assert.equal(created.session.title, "Named up front");

      const renamed = (await (
        await fetch(`${baseUrl}/api/sessions/${created.session.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        })
      ).json()) as { session: { title: string } };
      assert.equal(renamed.session.title, "Renamed");

      const deleted = await fetch(`${baseUrl}/api/sessions/${created.session.id}`, {
        method: "DELETE",
      });
      assert.equal(deleted.status, 204);

      const missing = await fetch(`${baseUrl}/api/sessions/${created.session.id}`);
      assert.equal(missing.status, 404);
    });
  });

  test("reject an empty title", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "   " }),
      });
      assert.equal(response.status, 400);
    });
  });
});

describe("POST /api/chat (agent mode)", () => {
  test("executes a read tool and reports it over the stream", async () => {
    const scripted = createScriptedFor([
      '{"tool": "list_files", "args": {"path": "."}}',
      "There is one file.",
    ]);

    await withTempServer({ provider: scripted, providers: [scripted] }, async (baseUrl) => {
      const events = await readSse(
        await postChat(baseUrl, { message: "what is in the workspace?", mode: "agent" }),
      );

      const call = eventsNamed(events, "tool_call")[0];
      assert.equal(call?.data.name, "list_files");
      assert.equal(call?.data.allowed, true);

      const result = eventsNamed(events, "tool_result")[0];
      assert.equal(result?.data.ok, true);

      assert.match(deltasOf(events), /one file/);

      // Tool activity is stored so the conversation still makes sense later.
      const sessionId = String(eventsNamed(events, "meta")[0]?.data.sessionId);
      const detail = (await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json()) as {
        session: { messages: Array<{ role: string; toolName?: string }> };
      };
      const roles = detail.session.messages.map((message) => message.role);
      assert.deepEqual(roles, ["user", "tool", "assistant"]);
      assert.equal(detail.session.messages[1]?.toolName, "list_files");
    });
  });

  test("refuses a write when the client did not allow file edits", async () => {
    const scripted = createScriptedFor([
      '{"tool": "write_file", "args": {"path": "sneaky.txt", "content": "x"}}',
      "I could not write it.",
    ]);

    await withTempServer({ provider: scripted, providers: [scripted] }, async (baseUrl) => {
      const events = await readSse(
        await postChat(baseUrl, { message: "write a file", mode: "agent" }),
      );

      const call = eventsNamed(events, "tool_call")[0];
      assert.equal(call?.data.allowed, false);
      assert.equal(eventsNamed(events, "tool_result")[0]?.data.ok, false);
    });
  });
});

describe("GET /api/health", () => {
  test("reports the active provider, tools and workspace", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 200);

      const body = (await response.json()) as {
        ok: boolean;
        provider: { id: string; model: string };
        providers: Array<{ id: string; active: boolean; detail: string }>;
        tools: Array<{ name: string; risk: string; ok: boolean }>;
        workspace: { dir: string };
      };

      assert.equal(body.ok, true);
      assert.equal(body.provider.id, "mock");
      assert.equal(body.provider.model, "mock");

      const active = body.providers.find((entry) => entry.active);
      assert.ok(active);
      assert.match(active.detail, /test double/);

      assert.ok(body.tools.length >= 5);
      assert.ok(body.tools.every((tool) => typeof tool.name === "string"));
      assert.ok(body.workspace.dir.length > 0);
    });
  });
});

describe("unknown api routes", () => {
  test("return a structured 404", async () => {
    await withTempServer({ provider, providers: [provider] }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/nope`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "not_found");
    });
  });
});

/** Local helper so this file does not depend on the scripted adapter details. */
function createScriptedFor(turns: string[]): ProviderAdapter {
  let index = 0;
  return {
    id: "scripted",
    kind: "test",
    label: "Scripted provider",
    defaultModel: "scripted",
    isAvailable: async () => ({ ok: true, detail: "Ready.", models: ["scripted"] }),
    listModels: async () => ["scripted"],
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const text = turns[index] ?? "";
      index += 1;
      yield { type: "delta", text };
      yield { type: "done", model: "scripted", finishReason: "stop", producedText: text !== "" };
    },
  };
}

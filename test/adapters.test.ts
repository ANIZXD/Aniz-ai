import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createMockAdapter } from "../src/providers/mock.ts";
import { createOllamaAdapter } from "../src/providers/ollama.ts";
import { createOpenAICompatibleAdapter } from "../src/providers/openaiCompatible.ts";
import { ProviderUnavailableError, UpstreamError } from "../src/errors.ts";
import type { ProviderAdapter, StreamEvent } from "../src/providers/types.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(adapter: ProviderAdapter, text: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamChat({
    messages: [{ role: "user", content: text }],
  })) {
    events.push(event);
  }
  return events;
}

function joinedText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === "delta")
    .map((event) => event.text)
    .join("");
}

describe("ollama adapter", () => {
  const options = { url: "http://ollama.test", model: "qwen3:0.6b", timeoutMs: 5_000 };

  test("streams deltas and reports a done event with usage", async () => {
    globalThis.fetch = (async () =>
      respondWith([
        '{"model":"qwen3:0.6b","message":{"content":"Hel"},"done":false}\n',
        '{"model":"qwen3:0.6b","message":{"content":"lo"},"done":false}\n',
        '{"model":"qwen3:0.6b","message":{"content":""},"done":true,',
        '"done_reason":"stop","prompt_eval_count":7,"eval_count":2}\n',
      ])) as typeof fetch;

    const events = await collect(createOllamaAdapter(options), "hi");
    assert.equal(joinedText(events), "Hello");

    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done?.type === "done" ? done.model : "", "qwen3:0.6b");
    assert.equal(done?.type === "done" ? done.finishReason : "", "stop");
    assert.equal(done?.type === "done" ? done.producedText : false, true);
    assert.equal(done?.type === "done" ? done.usage?.completionTokens : null, 2);
  });

  test("skips a malformed line instead of failing the whole reply", async () => {
    globalThis.fetch = (async () =>
      respondWith([
        '{"message":{"content":"one "},"done":false}\n',
        "not json at all\n",
        '{"message":{"content":"two"},"done":false}\n',
        '{"done":true,"done_reason":"stop"}\n',
      ])) as typeof fetch;

    const events = await collect(createOllamaAdapter(options), "hi");
    assert.equal(joinedText(events), "one two");
    assert.equal(events.at(-1)?.type, "done");
  });

  test("maps an unavailable server to a friendly message", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch;

    await assert.rejects(
      () => collect(createOllamaAdapter(options), "hi"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderUnavailableError);
        assert.match(error.message, /Make sure Ollama is running/);
        return true;
      },
    );
  });

  test("finds the reason inside an AggregateError cause chain", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
      code: "ECONNREFUSED",
    });
    const aggregate = new AggregateError([refused], "");
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", { cause: aggregate });
    }) as typeof fetch;

    await assert.rejects(
      () => collect(createOllamaAdapter(options), "hi"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderUnavailableError);
        assert.match(error.message, /Make sure Ollama is running/);
        return true;
      },
    );
  });

  test("reports a missing model when the server answers 404", async () => {
    globalThis.fetch = (async () =>
      new Response("model not found", { status: 404 })) as typeof fetch;

    await assert.rejects(
      () => collect(createOllamaAdapter(options), "hi"),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.match(error.message, /not installed/);
        return true;
      },
    );
  });

  test("surfaces a mid-stream error object as an upstream error", async () => {
    globalThis.fetch = (async () =>
      respondWith(['{"error":"model requires more system memory"}\n'])) as typeof fetch;

    await assert.rejects(
      () => collect(createOllamaAdapter(options), "hi"),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.match(error.message, /more system memory/);
        return true;
      },
    );
  });

  test("isAvailable explains when the server cannot be reached", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    }) as typeof fetch;

    const availability = await createOllamaAdapter(options).isAvailable();
    assert.equal(availability.ok, false);
    assert.match(availability.detail, /Cannot reach the local model/);
  });

  test("isAvailable warns when the configured model is not installed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3:8b" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const availability = await createOllamaAdapter(options).isAvailable();
    assert.equal(availability.ok, true);
    assert.match(availability.detail, /qwen3:0.6b is not installed/);
    assert.deepEqual(availability.models, ["llama3:8b"]);
  });
});

describe("openai-compatible adapter", () => {
  const options = {
    baseUrl: "http://endpoint.test/v1",
    apiKey: "test-key",
    model: "test-model",
    timeoutMs: 5_000,
  };

  test("streams delta content until [DONE]", async () => {
    globalThis.fetch = (async () =>
      respondWith([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        ": comment line\n\n",
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const events = await collect(createOpenAICompatibleAdapter(options), "hi");
    assert.equal(joinedText(events), "Hi there");
    assert.equal(events.at(-1)?.type, "done");
  });

  test("refuses to run when it is not configured", async () => {
    const adapter = createOpenAICompatibleAdapter({ ...options, apiKey: "" });
    await assert.rejects(
      () => collect(adapter, "hi"),
      (error: unknown) => {
        assert.ok(error instanceof ProviderUnavailableError);
        assert.match(error.message, /not configured/);
        return true;
      },
    );
  });

  test("maps a rejected key to a friendly message", async () => {
    globalThis.fetch = (async () =>
      new Response("unauthorized", { status: 401 })) as typeof fetch;

    await assert.rejects(
      () => collect(createOpenAICompatibleAdapter(options), "hi"),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.match(error.message, /API key was rejected/);
        return true;
      },
    );
  });
});

describe("mock adapter", () => {
  test("echoes the last user message and completes", async () => {
    const events = await collect(createMockAdapter(), "hello there");
    assert.match(joinedText(events), /hello there/);
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    assert.equal(done?.type === "done" ? done.producedText : false, true);
  });

  test("stops promptly when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort();

    const events: StreamEvent[] = [];
    for await (const event of createMockAdapter({ delayMs: 1 }).streamChat({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })) {
      events.push(event);
    }

    assert.equal(events.length, 0);
  });
});

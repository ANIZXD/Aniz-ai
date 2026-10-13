import type { Availability, ChatRequest, ProviderAdapter, StreamEvent } from "./types.ts";

export interface MockOptions {
  /** Delay between chunks, for exercising the streaming UI. */
  delayMs?: number;
  /** Fixed reply text. Defaults to an echo of the last user message. */
  text?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A deterministic offline test double. It is NOT a language model: it echoes the
 * last user message so the transport, validation and UI can be tested without a
 * network, a model, or an account. Say so wherever it is surfaced.
 */
export function createMockAdapter(options: MockOptions = {}): ProviderAdapter {
  const delayMs = options.delayMs ?? 0;
  const availability: Availability = {
    ok: true,
    detail: "Mock provider active — a deterministic test double, not a language model.",
    models: ["mock"],
  };

  return {
    id: "mock",
    kind: "test",
    label: "Mock (test double)",
    defaultModel: "mock",

    async isAvailable(): Promise<Availability> {
      return availability;
    },

    async listModels(): Promise<string[]> {
      return ["mock"];
    },

    async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const reply =
        options.text ??
        `Mock reply. You said: "${lastUser?.content ?? ""}". ` +
          "This is a deterministic test double, not a language model.";

      const pieces = reply.match(/\S+\s*/g) ?? [reply];
      let producedText = false;

      for (const piece of pieces) {
        if (request.signal?.aborted) return;
        if (delayMs > 0) await sleep(delayMs);
        producedText = true;
        yield { type: "delta", text: piece };
      }

      yield {
        type: "done",
        model: "mock",
        finishReason: "stop",
        producedText,
        usage: { promptTokens: lastUser?.content.length ?? 0, completionTokens: pieces.length },
      };
    },
  };
}

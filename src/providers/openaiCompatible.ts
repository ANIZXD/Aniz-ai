import { logger } from "../logger.ts";
import { readLines } from "../lib/lines.ts";
import {
  ProviderUnavailableError,
  UpstreamError,
  isAbortError,
} from "../errors.ts";
import type {
  Availability,
  ChatRequest,
  ProviderAdapter,
  StreamEvent,
} from "./types.ts";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

interface ChatCompletionChunk {
  model?: unknown;
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  error?: { message?: unknown };
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createOpenAICompatibleAdapter(
  options: OpenAICompatibleOptions,
): ProviderAdapter {
  const base = trimUrl(options.baseUrl);
  const configured = base !== "" && options.apiKey !== "";

  function notConfigured(): Availability {
    return {
      ok: false,
      detail:
        "Not configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env to enable it.",
    };
  }

  return {
    id: "openai",
    kind: "cloud",
    label: "OpenAI-compatible endpoint",
    defaultModel: options.model,

    async isAvailable(): Promise<Availability> {
      if (!configured || options.model === "") return notConfigured();
      try {
        const response = await fetch(`${base}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, detail: "The configured API key was rejected." };
        }
        if (!response.ok) {
          return { ok: false, detail: `The endpoint answered with status ${response.status}.` };
        }
        return { ok: true, detail: `Endpoint is ready, using ${options.model}.` };
      } catch (err) {
        if (isAbortError(err)) {
          return { ok: false, detail: "The endpoint did not respond in time." };
        }
        return { ok: false, detail: "Cannot reach the configured endpoint." };
      }
    },

    async listModels(): Promise<string[]> {
      if (!configured) return [];
      try {
        const response = await fetch(`${base}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return [];
        const data = (await response.json()) as { data?: Array<{ id?: unknown }> };
        return (data.data ?? [])
          .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
          .filter((id): id is string => id !== "");
      } catch {
        return [];
      }
    },

    async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
      if (!configured) {
        throw new ProviderUnavailableError(
          "This provider is not configured. Add LLM_BASE_URL, LLM_API_KEY and LLM_MODEL to .env, or set PROVIDER=ollama.",
        );
      }
      const model = request.model ?? options.model;
      if (model === "") {
        throw new ProviderUnavailableError("No model is set for this provider (LLM_MODEL).");
      }

      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, messages: request.messages, stream: true }),
          signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          if (err instanceof Error && err.name === "TimeoutError") {
            throw new UpstreamError(
              `The endpoint did not respond within ${Math.round(options.timeoutMs / 1000)}s.`,
              err,
            );
          }
          return;
        }
        throw new ProviderUnavailableError("Cannot reach the configured endpoint.", err);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new UpstreamError(
          response.status === 401 || response.status === 403
            ? "The configured API key was rejected."
            : `The endpoint answered with status ${response.status}.`,
          body.slice(0, 400),
        );
      }
      if (!response.body) {
        throw new UpstreamError("The endpoint returned an empty response.");
      }

      let producedText = false;

      for await (const line of readLines(response.body)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith(":")) continue;

        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") break;

        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(payload) as ChatCompletionChunk;
        } catch {
          logger.warn("Skipping a malformed chunk from the endpoint");
          continue;
        }

        if (chunk.error) {
          const message = typeof chunk.error.message === "string" ? chunk.error.message : "The endpoint reported an error.";
          throw new UpstreamError(message);
        }

        const choice = chunk.choices?.[0];
        const content = choice?.delta?.content;
        if (typeof content === "string" && content !== "") {
          producedText = true;
          yield { type: "delta", text: content };
        }
      }

      yield {
        type: "done",
        model,
        finishReason: producedText ? "stop" : "empty",
        producedText,
      };
    },
  };
}

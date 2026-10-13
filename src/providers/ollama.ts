import { logger } from "../logger.ts";
import { readLines } from "../lib/lines.ts";
import { looksLikeConnectionRefused, networkDetail } from "../lib/network.ts";
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

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs: number;
  /** Sampling knobs. Optional so a caller can build a minimal adapter. */
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  /** Ask a thinking model to skip its reasoning phase. */
  think?: boolean;
  /** Sequences that end generation, used to cut canned filler openings. */
  stop?: string[];
}

interface OllamaTag {
  name?: unknown;
  model?: unknown;
}

interface OllamaChunk {
  model?: unknown;
  message?: { content?: unknown };
  response?: unknown;
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkErrorMessage(err: unknown): string {
  const detail = networkDetail(err);
  const hint = looksLikeConnectionRefused(detail)
    ? "Make sure Ollama is running."
    : "Check that the Ollama URL is correct.";
  return `Cannot reach the local model. ${hint}`;
}

export function createOllamaAdapter(options: OllamaOptions): ProviderAdapter {
  const base = trimUrl(options.url);

  async function fetchTags(timeoutMs: number): Promise<Response> {
    return fetch(`${base}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fetchModelNames(timeoutMs: number): Promise<string[]> {
    const response = await fetchTags(timeoutMs);
    if (!response.ok) {
      throw new UpstreamError(`Ollama answered with status ${response.status}.`);
    }
    const data = (await response.json()) as { models?: OllamaTag[] };
    const models = Array.isArray(data.models) ? data.models : [];
    return models
      .map((tag) => (typeof tag.name === "string" ? tag.name : typeof tag.model === "string" ? tag.model : ""))
      .filter((name): name is string => name !== "");
  }

  return {
    id: "ollama",
    kind: "local",
    label: "Ollama (local)",
    defaultModel: options.model,

    async isAvailable(): Promise<Availability> {
      try {
        const models = await fetchModelNames(4_000);
        if (models.length === 0) {
          return {
            ok: false,
            detail: "Ollama is running but no models are installed yet.",
            models,
          };
        }
        const wanted = models.includes(options.model);
        return {
          ok: true,
          detail: wanted
            ? `Ollama is ready with ${options.model}.`
            : `Ollama is ready, but ${options.model} is not installed (available: ${models.join(", ")}).`,
          models,
        };
      } catch (err) {
        if (isAbortError(err)) {
          return { ok: false, detail: "The local model server did not respond in time." };
        }
        return { ok: false, detail: networkErrorMessage(err) };
      }
    },

    async listModels(): Promise<string[]> {
      try {
        return await fetchModelNames(4_000);
      } catch {
        return [];
      }
    },

    async *streamChat(request: ChatRequest): AsyncGenerator<StreamEvent> {
      const model = request.model ?? options.model;

      // Only the knobs that were actually configured are sent, so Ollama's own
      // defaults are left alone otherwise.
      const sampling: Record<string, unknown> = {};
      if (options.temperature !== undefined) sampling.temperature = options.temperature;
      if (options.topP !== undefined) sampling.top_p = options.topP;
      if (options.repeatPenalty !== undefined) sampling.repeat_penalty = options.repeatPenalty;
      if (options.stop !== undefined && options.stop.length > 0) sampling.stop = options.stop;

      const send = (includeThink: boolean): Promise<Response> =>
        fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: request.messages,
            stream: true,
            options: sampling,
            ...(includeThink ? { think: options.think === true } : {}),
          }),
          signal: combineSignals(request.signal, options.timeoutMs),
        });

      const sendThink = options.think !== undefined;
      let response: Response;
      try {
        response = await send(sendThink);
      } catch (err) {
        if (isAbortError(err)) {
          if (err instanceof Error && err.name === "TimeoutError") {
            throw new UpstreamError(
              `The model did not respond within ${Math.round(options.timeoutMs / 1000)}s.`,
              err,
            );
          }
          return; // the caller cancelled; not an error worth reporting
        }
        throw new ProviderUnavailableError(networkErrorMessage(err), err);
      }

      // Not every model understands the `think` flag. If it is the reason the
      // request was rejected, drop it and try once more instead of failing the
      // whole turn over an optional optimisation.
      let rejectedDetail: string | null = null;
      if (!response.ok && sendThink && response.status === 400) {
        rejectedDetail = await response.text().catch(() => "");
        if (/think/i.test(rejectedDetail)) {
          logger.warn("The model rejected the thinking option; retrying without it");
          response = await send(false);
          rejectedDetail = null;
        }
      }

      if (!response.ok) {
        const body = rejectedDetail ?? (await response.text().catch(() => ""));
        logger.warn("Ollama rejected the request", { status: response.status });
        throw new UpstreamError(
          response.status === 404
            ? `The model "${model}" is not installed in Ollama.`
            : `The model server answered with status ${response.status}.`,
          body.slice(0, 400),
        );
      }

      if (!response.body) {
        throw new UpstreamError("The model returned an empty response.");
      }

      let producedText = false;

      for await (const line of readLines(response.body)) {
        const trimmed = line.trim();
        if (trimmed === "") continue;

        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaChunk;
        } catch {
          logger.warn("Skipping a malformed line from Ollama");
          continue;
        }

        if (typeof chunk.error === "string" && chunk.error !== "") {
          throw new UpstreamError(chunk.error);
        }

        const content = chunk.message?.content ?? chunk.response;
        if (typeof content === "string" && content !== "") {
          producedText = true;
          yield { type: "delta", text: content };
        }

        if (chunk.done === true) {
          yield {
            type: "done",
            model: typeof chunk.model === "string" ? chunk.model : model,
            finishReason: typeof chunk.done_reason === "string" ? chunk.done_reason : "stop",
            producedText,
            usage: {
              promptTokens: typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined,
              completionTokens: typeof chunk.eval_count === "number" ? chunk.eval_count : undefined,
            },
          };
          return;
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

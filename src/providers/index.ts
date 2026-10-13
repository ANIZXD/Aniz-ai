import type { AppConfig, ProviderId } from "../config.ts";
import { createMockAdapter } from "./mock.ts";
import { createOllamaAdapter } from "./ollama.ts";
import { createOpenAICompatibleAdapter } from "./openaiCompatible.ts";
import type { ProviderAdapter } from "./types.ts";

export function createAdapter(id: ProviderId, config: AppConfig): ProviderAdapter {
  switch (id) {
    case "ollama":
      return createOllamaAdapter({
        url: config.ollama.url,
        model: config.ollama.model,
        timeoutMs: config.requestTimeoutMs,
        temperature: config.ollama.temperature,
        topP: config.ollama.topP,
        repeatPenalty: config.ollama.repeatPenalty,
        think: config.ollama.think,
        stop: config.ollama.stop,
      });
    case "openai":
      return createOpenAICompatibleAdapter({
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey,
        model: config.openai.model,
        timeoutMs: config.requestTimeoutMs,
      });
    case "mock":
      return createMockAdapter();
  }
}

export function resolveProvider(config: AppConfig): ProviderAdapter {
  return createAdapter(config.provider, config);
}

/**
 * Adapters to report in health output: the active one, plus any alternate that
 * is actually configured. Unused, unconfigured providers are left out.
 */
export function listProviders(config: AppConfig): ProviderAdapter[] {
  const ids: ProviderId[] = [config.provider];

  if (config.provider !== "ollama") ids.push("ollama");
  if (
    config.provider !== "openai" &&
    config.openai.baseUrl !== "" &&
    config.openai.apiKey !== "" &&
    config.openai.model !== ""
  ) {
    ids.push("openai");
  }

  return ids.map((id) => createAdapter(id, config));
}

export type { ProviderAdapter } from "./types.ts";

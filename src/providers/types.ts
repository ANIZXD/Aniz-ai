export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface StreamDelta {
  type: "delta";
  text: string;
}

export interface StreamDone {
  type: "done";
  model: string;
  finishReason: string;
  /** Whether any text was actually produced; an empty reply is a real outcome. */
  producedText: boolean;
  usage?: ChatUsage;
}

export type StreamEvent = StreamDelta | StreamDone;

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
}

export interface Availability {
  ok: boolean;
  /** Human-readable status, safe to display in the UI. */
  detail: string;
  models?: string[];
}

/**
 * One model backend. Implementations own their transport and must map their
 * failures onto AppError subclasses with user-friendly messages.
 */
export interface ProviderAdapter {
  readonly id: string;
  /** `local` runs on this machine; `cloud` requires an external account. */
  readonly kind: "local" | "cloud" | "test";
  readonly label: string;
  /** Model used when a request does not name one. */
  readonly defaultModel: string;
  isAvailable(): Promise<Availability>;
  listModels(): Promise<string[]>;
  streamChat(request: ChatRequest): AsyncGenerator<StreamEvent>;
}

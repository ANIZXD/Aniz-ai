import path from "node:path";
import "dotenv/config";

export const APP_NAME = "ANIZ AI";
export const APP_VERSION = "0.2.0";

export type ProviderId = "ollama" | "openai" | "mock";

/**
 * How much of the transcript chat mode sends back to the model.
 *
 * `full` (the default) gives the model its own previous answers, so it can
 * follow the thread. The catch is that a small local model reads that wording
 * back and repeats one sentence verbatim turn after turn. `user` hides the
 * model's own replies: the repeating stops, but so does the model's grip on the
 * thread, and an unrelated follow-up question can get answered with the earlier
 * topic. Both were measured against `qwen3:0.6b`; neither is free.
 */
export type ChatHistoryMode = "full" | "user";

export interface AppConfig {
  host: string;
  port: number;
  provider: ProviderId;
  requestTimeoutMs: number;
  dataDir: string;
  workspaceDir: string;
  sessionsFile: string;
  maxAgentSteps: number;
  chatHistory: ChatHistoryMode;
  ollama: {
    url: string;
    model: string;
    /** Sampling knobs: small local models repeat themselves without these. */
    temperature: number;
    topP: number;
    repeatPenalty: number;
    /** Ask a thinking model to skip its reasoning phase. */
    think: boolean;
    /** Phrases that end generation early. See DEFAULT_STOPS. */
    stop: string[];
  };
  openai: { baseUrl: string; apiKey: string; model: string };
}

const PROVIDER_IDS: readonly ProviderId[] = ["ollama", "openai", "mock"];

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return value === "" ? fallback : value;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function readFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

const TRUTHY = ["1", "true", "yes", "on"];
const FALSY = ["0", "false", "no", "off"];

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.includes(value)) return true;
  if (FALSY.includes(value)) return false;
  return fallback;
}

/**
 * Sign-offs that small local models tack onto nearly every reply. Ollama stops
 * generating the moment one appears, which is the only reliable way to keep a
 * 1B-ish model from ending every turn like a help desk. The system prompt asks
 * for the same thing (see CONVERSATION_STYLE); this is the enforcement.
 */
export const DEFAULT_STOPS: readonly string[] = [
  "Let me know",
  "let me know",
  "How may I assist",
  "How can I assist",
  "How can I help",
  "Is there anything else",
  "is there anything else",
  "Is there anything I can",
  "Do you need help",
  "Do you need assistance",
  "Do you have any other",
  "If you have any other",
  "Feel free to ask",
  "feel free to ask",
  "Would you like to know more",
  "What can I do for you",
  "What would you like me to",
  "Would you like me to",
  "If you need anything",
];

/** Comma-separated list. `OLLAMA_STOP=none` disables the list entirely. */
function readList(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return [...fallback];
  const value = raw.trim();
  if (value === "none" || value === "-") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function readProvider(): ProviderId {
  const raw = readString("PROVIDER", "ollama").toLowerCase();
  return (PROVIDER_IDS as readonly string[]).includes(raw) ? (raw as ProviderId) : "ollama";
}

const CHAT_HISTORY_MODES: readonly ChatHistoryMode[] = ["full", "user"];

function readChatHistory(): ChatHistoryMode {
  const raw = readString("CHAT_HISTORY", "full").toLowerCase();
  return (CHAT_HISTORY_MODES as readonly string[]).includes(raw) ? (raw as ChatHistoryMode) : "full";
}

/** Relative paths are resolved against the working directory. */
function resolveDir(value: string, fallback: string): string {
  const base = value === "" ? fallback : value;
  return path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDir(readString("DATA_DIR", ""), "data");

  return {
    host: readString("HOST", "127.0.0.1"),
    port: readInt("PORT", 3210, 1, 65535),
    provider: readProvider(),
    requestTimeoutMs: readInt("REQUEST_TIMEOUT_MS", 300_000, 1_000, 3_600_000),
    dataDir,
    workspaceDir: resolveDir(readString("WORKSPACE_DIR", ""), path.join("data", "workspace")),
    sessionsFile: path.join(dataDir, "sessions.json"),
    maxAgentSteps: readInt("MAX_AGENT_STEPS", 6, 1, 20),
    chatHistory: readChatHistory(),
    ollama: {
      url: readString("OLLAMA_URL", "http://localhost:11434"),
      model: readString("OLLAMA_MODEL", "qwen3:0.6b"),
      temperature: readFloat("OLLAMA_TEMPERATURE", 0.8, 0, 2),
      topP: readFloat("OLLAMA_TOP_P", 0.95, 0, 1),
      repeatPenalty: readFloat("OLLAMA_REPEAT_PENALTY", 1.15, 1, 2),
      think: readBool("OLLAMA_THINK", false),
      stop: readList("OLLAMA_STOP", DEFAULT_STOPS),
    },
    openai: {
      baseUrl: readString("LLM_BASE_URL", ""),
      apiKey: readString("LLM_API_KEY", ""),
      model: readString("LLM_MODEL", ""),
    },
  };
}

/** Safe-to-log summary. Never includes a secret value. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    provider: config.provider,
    requestTimeoutMs: config.requestTimeoutMs,
    dataDir: config.dataDir,
    workspaceDir: config.workspaceDir,
    maxAgentSteps: config.maxAgentSteps,
    chatHistory: config.chatHistory,
    ollama: {
      url: config.ollama.url,
      model: config.ollama.model,
      temperature: config.ollama.temperature,
      topP: config.ollama.topP,
      repeatPenalty: config.ollama.repeatPenalty,
      think: config.ollama.think,
      stopCount: config.ollama.stop.length,
    },
    openai: {
      configured: config.openai.baseUrl !== "" && config.openai.apiKey !== "",
      baseUrl: config.openai.baseUrl === "" ? null : config.openai.baseUrl,
      model: config.openai.model === "" ? null : config.openai.model,
      apiKey: config.openai.apiKey === "" ? "unset" : "set",
    },
  };
}

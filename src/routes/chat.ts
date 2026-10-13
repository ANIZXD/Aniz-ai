import { Router } from "express";
import { runAgent, type AgentEvent } from "../agent/agent.ts";
import { AGENT_MODES, AGENT_ROLES, type AgentMode, type AgentRole } from "../agent/prompts.ts";
import { BadRequestError, NotFoundError, toAppError } from "../errors.ts";
import { logger } from "../logger.ts";
import { sendComment, sendEvent, startEventStream } from "../lib/sse.ts";
import { MAX_CONTEXT_MESSAGES, type Session } from "../sessions/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import type { ChatMessage, ChatRole, ProviderAdapter } from "../providers/types.ts";
import type { ChatHistoryMode } from "../config.ts";

const MAX_MESSAGE_CHARS = 32_000;
const MAX_MESSAGES = 64;
const HEARTBEAT_MS = 10_000;
const MAX_STORED_TOOL_CHARS = 2_000;

const ROLES: readonly ChatRole[] = ["system", "user", "assistant"];

export interface ChatDeps {
  getProvider: () => ProviderAdapter;
  registry: ToolRegistry;
  store: SessionStore;
  workspaceDir: string;
  maxAgentSteps: number;
  /** See ChatHistoryMode: chat mode may hide the model's own earlier replies. */
  chatHistory: ChatHistoryMode;
}

export interface ChatInput {
  /** The new user message for this turn. Empty when `retry` is set. */
  message: string;
  /** Set only for the stateless `messages` form; null means use the session. */
  providedHistory: ChatMessage[] | null;
  /** Re-run the last user message in the session without appending it again. */
  retry: boolean;
  sessionId?: string;
  mode: AgentMode;
  role: AgentRole;
  review: boolean;
  allowWrite: boolean;
  allowDestructive: boolean;
  model?: string;
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestError(`"${label}" must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function readFlag(value: unknown): boolean {
  return value === true;
}

function validateMessages(candidate: unknown): ChatMessage[] {
  if (!Array.isArray(candidate)) {
    throw new BadRequestError("'messages' must be an array.");
  }
  if (candidate.length === 0) throw new BadRequestError("Your message is empty.");
  if (candidate.length > MAX_MESSAGES) {
    throw new BadRequestError(`That conversation is too long (max ${MAX_MESSAGES} messages).`);
  }

  const messages: ChatMessage[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) {
      throw new BadRequestError("Each message needs a 'role' and 'content'.");
    }
    const { role, content } = entry as Record<string, unknown>;

    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      throw new BadRequestError("A message 'role' must be user, assistant or system.");
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new BadRequestError("A message cannot be empty.");
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw new BadRequestError(`That message is too long (max ${MAX_MESSAGE_CHARS} characters).`);
    }

    messages.push({ role: role as ChatRole, content });
  }
  return messages;
}

/** Validates an untrusted request body into a ChatInput. */
export function parseChatBody(body: unknown): ChatInput {
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("Send a JSON body with a 'message' or 'messages' field.");
  }
  const raw = body as Record<string, unknown>;

  const mode = readEnum<AgentMode>(raw.mode, AGENT_MODES, "chat", "mode");
  const role = readEnum<AgentRole>(raw.role, AGENT_ROLES, "assistant", "role");
  const review = readFlag(raw.review);
  const allowWrite = readFlag(raw.allowWrite);
  const allowDestructive = readFlag(raw.allowDestructive);

  let model: string | undefined;
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.trim() === "" || raw.model.length > 200) {
      throw new BadRequestError("'model' must be a short, non-empty string.");
    }
    model = raw.model.trim();
  }

  let sessionId: string | undefined;
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== "string" || raw.sessionId.trim() === "") {
      throw new BadRequestError("'sessionId' must be a non-empty string.");
    }
    sessionId = raw.sessionId.trim();
  }

  const common = {
    mode,
    role,
    review,
    retry: false,
    allowWrite,
    allowDestructive,
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };

  // Retry: reuse the last user message already stored in the session.
  if (readFlag(raw.retry)) {
    if (sessionId === undefined) {
      throw new BadRequestError("'retry' needs a 'sessionId'.");
    }
    return { message: "", providedHistory: null, ...common, retry: true };
  }

  if (typeof raw.message === "string") {
    if (raw.message.trim() === "") throw new BadRequestError("Your message is empty.");
    if (raw.message.length > MAX_MESSAGE_CHARS) {
      throw new BadRequestError(`That message is too long (max ${MAX_MESSAGE_CHARS} characters).`);
    }
    return { message: raw.message, providedHistory: null, ...common };
  }

  if (Array.isArray(raw.messages)) {
    const history = validateMessages(raw.messages);
    const last = history[history.length - 1];
    if (last?.role !== "user") {
      throw new BadRequestError("The last message must be from the user.");
    }
    return { message: last.content, providedHistory: history, ...common };
  }

  throw new BadRequestError("Send a JSON body with a 'message' or 'messages' field.");
}

/** Maps stored messages onto provider roles for the model. */
function toHistory(session: Session): ChatMessage[] {
  return session.messages.slice(-MAX_CONTEXT_MESSAGES).map((message) => {
    if (message.role === "tool") {
      return {
        role: "user" as const,
        content: `TOOL RESULT (${message.toolName ?? "tool"}) ok=${message.ok === true}:\n${message.content}`,
      };
    }
    return { role: message.role === "assistant" ? ("assistant" as const) : ("user" as const), content: message.content };
  });
}

/**
 * Chooses what the model is allowed to see of the conversation so far.
 *
 * Agent and plan modes always get the whole transcript: they need their own
 * tool calls to make sense of a result. Chat mode normally does too, but with
 * `user` history it drops the assistant's own replies, because a small model
 * reads them back as a script and repeats a sentence verbatim for the rest of
 * the conversation.
 */
export function historyForModel(
  history: ChatMessage[],
  mode: AgentMode,
  chatHistory: ChatHistoryMode,
): ChatMessage[] {
  if (mode !== "chat" || chatHistory === "full") return history;
  return history.filter((message) => message.role !== "assistant");
}

export function createChatRouter(deps: ChatDeps): Router {
  const router = Router();

  router.post("/", async (request, response) => {
    let input: ChatInput;
    try {
      input = parseChatBody(request.body);
    } catch (error) {
      const appError = toAppError(error);
      response.status(appError.status).json(appError.toJSON());
      return;
    }

    // Resolve which conversation this turn belongs to.
    let session: Session | null = null;
    if (input.sessionId !== undefined) {
      session = await deps.store.get(input.sessionId);
      if (!session) {
        const appError = new NotFoundError("That conversation does not exist.");
        response.status(appError.status).json(appError.toJSON());
        return;
      }
    } else if (input.providedHistory === null) {
      session = await deps.store.create();
    }

    if (session && input.retry) {
      // Re-run the last user message rather than storing it twice.
      const lastUser = [...session.messages].reverse().find((message) => message.role === "user");
      if (!lastUser) {
        const appError = new BadRequestError("There is nothing to retry in this conversation.");
        response.status(appError.status).json(appError.toJSON());
        return;
      }
      input.message = lastUser.content;
    } else if (session) {
      session = await deps.store.append(session.id, { role: "user", content: input.message });
    }

    const history: ChatMessage[] = historyForModel(
      session ? toHistory(session) : (input.providedHistory ?? []),
      input.mode,
      deps.chatHistory,
    );

    const provider = deps.getProvider();
    const controller = new AbortController();

    // `request`'s "close" fires once its body has been read, which is not a
    // disconnect. The response's "close" is: if it fires while the response is
    // still unfinished, the client went away.
    response.on("close", () => {
      if (!response.writableEnded) {
        logger.info("Client disconnected before the reply finished");
        controller.abort();
      }
    });

    startEventStream(response);
    const heartbeat = setInterval(() => sendComment(response, "keep-alive"), HEARTBEAT_MS);

    sendEvent(response, "meta", {
      provider: provider.id,
      model: input.model ?? provider.defaultModel,
      sessionId: session?.id ?? null,
      mode: input.mode,
      role: input.role,
      review: input.review,
      allowWrite: input.allowWrite,
      allowDestructive: input.allowDestructive,
    });

    const context: ToolContext = {
      workspaceDir: deps.workspaceDir,
      allowWrite: input.allowWrite,
      allowDestructive: input.allowDestructive,
      signal: controller.signal,
    };

    let assistantText = "";
    let reviewText = "";
    const toolMessages: Array<{ name: string; ok: boolean; summary: string }> = [];
    const finalEvent: { value: Extract<AgentEvent, { type: "done" }> | null } = { value: null };
    let persisted = false;

    const persist = async (): Promise<void> => {
      if (persisted || session === null) return;
      persisted = true;
      for (const tool of toolMessages) {
        await deps.store.append(session.id, {
          role: "tool",
          content: tool.summary.slice(0, MAX_STORED_TOOL_CHARS),
          toolName: tool.name,
          ok: tool.ok,
        });
      }
      if (assistantText.trim() !== "") {
        await deps.store.append(session.id, { role: "assistant", content: assistantText });
      }
      if (reviewText.trim() !== "") {
        await deps.store.append(session.id, {
          role: "assistant",
          content: `[Verifier]\n${reviewText}`,
        });
      }
    };

    try {
      for await (const event of runAgent({
        provider,
        registry: deps.registry,
        history,
        mode: input.mode,
        role: input.role,
        review: input.review,
        context,
        maxSteps: deps.maxAgentSteps,
        signal: controller.signal,
        ...(input.model === undefined ? {} : { model: input.model }),
      })) {
        if (controller.signal.aborted) return;

        switch (event.type) {
          case "delta":
            assistantText += event.text;
            sendEvent(response, "delta", { text: event.text });
            break;

          case "tool_call":
            sendEvent(response, "tool_call", {
              id: event.id,
              name: event.name,
              risk: event.risk,
              args: event.args,
              allowed: event.allowed,
              reason: event.reason ?? null,
            });
            break;

          case "tool_result":
            toolMessages.push({ name: event.name, ok: event.ok, summary: event.summary });
            sendEvent(response, "tool_result", {
              id: event.id,
              name: event.name,
              ok: event.ok,
              verified: event.verified,
              summary: event.summary,
            });
            break;

          case "review":
            reviewText += event.text;
            sendEvent(response, "review", { text: event.text });
            break;

          case "done":
            finalEvent.value = event;
            break;
        }
      }

      sendEvent(response, "done", {
        sessionId: session?.id ?? null,
        finishReason: finalEvent.value?.finishReason ?? "stop",
        steps: finalEvent.value?.steps ?? 1,
        usage: finalEvent.value?.usage ?? null,
      });
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === "cancelled" || controller.signal.aborted) {
        logger.info("Chat request cancelled by the client");
      } else {
        logger.error("Chat request failed", { code: appError.code, status: appError.status });
        sendEvent(response, "error", appError.toJSON().error);
      }
    } finally {
      clearInterval(heartbeat);
      try {
        await persist();
      } catch (error) {
        logger.error("Could not save the conversation", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
      if (!response.writableEnded) response.end();
    }
  });

  return router;
}

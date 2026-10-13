import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatUsage, ProviderAdapter } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContext, ToolResult, ToolRisk } from "../tools/types.ts";
import { buildReviewPrompt, buildSystemPrompt, type AgentMode, type AgentRole } from "./prompts.ts";
import { looksUndecided, parseToolCall } from "./protocol.ts";
import { createTrailingFilter, stripTrailingFiller } from "./style.ts";
import { summarizeToolOutcomes, type ToolOutcome } from "./verifier.ts";

export type AgentEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      risk: ToolRisk;
      args: Record<string, unknown>;
      allowed: boolean;
      reason?: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      verified: boolean;
      summary: string;
    }
  | { type: "review"; text: string }
  | { type: "done"; finishReason: string; steps: number; usage?: ChatUsage };

export interface RunAgentOptions {
  provider: ProviderAdapter;
  registry: ToolRegistry;
  /** Conversation so far, already mapped to provider roles. */
  history: ChatMessage[];
  mode: AgentMode;
  role: AgentRole;
  /** Run a verifier pass after an agent run. */
  review: boolean;
  context: ToolContext;
  maxSteps: number;
  signal?: AbortSignal;
  model?: string;
}

function decide(
  tool: { risk: ToolRisk } | undefined,
  context: ToolContext,
): { allowed: boolean; reason?: string } {
  if (!tool) return { allowed: false, reason: "There is no tool by that name." };

  if (tool.risk === "read") return { allowed: true };

  if (tool.risk === "write") {
    return context.allowWrite
      ? { allowed: true }
      : {
          allowed: false,
          reason:
            "File edits are not enabled for this request. Ask the user to turn on file edits first.",
        };
  }

  return context.allowDestructive
    ? { allowed: true }
    : {
        allowed: false,
        reason: "Deleting is never automatic. Ask the user to confirm the deletion first.",
      };
}

/** Keeps the head and tail of a long transcript within a size budget. */
function condense(messages: ChatMessage[], limit = 8_000): string {
  const text = messages
    .filter((message) => message.role !== "system")
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");

  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n…(trimmed)…\n\n${text.slice(-half)}`;
}

/**
 * Runs one assistant turn, optionally with a tool loop.
 *
 * Yields `delta` events as text is produced, `tool_call`/`tool_result` events as
 * tools run, an optional `review` event from the verifier, and finally `done`.
 */
export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, registry, mode, role, context, maxSteps, signal, model } = options;
  const useTools = mode === "agent";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        mode,
        role,
        tools: useTools ? registry.describe() : "",
      }),
    },
    ...options.history,
  ];

  const outcomes: ToolOutcome[] = [];
  const executed = new Set<string>();
  let steps = 0;
  let usage: ChatUsage | undefined;
  let finishReason = "stop";

  for (;;) {
    if (signal?.aborted) return;
    steps += 1;

    let held = "";
    let decided = false;
    let emitted = 0;
    const filter = createTrailingFilter();

    for await (const event of provider.streamChat({ messages, signal, model })) {
      if (event.type !== "delta") {
        if (event.usage) usage = event.usage;
        continue;
      }

      // An empty chunk is not content.
      if (event.text === "") continue;

      if (decided) {
        const out = filter.push(event.text);
        if (out !== "") {
          emitted += out.length;
          yield { type: "delta", text: out };
        }
        continue;
      }

      held += event.text;

      // Without tools there is nothing to disambiguate: stream straight through.
      if (useTools && looksUndecided(held)) continue;

      decided = true;
      const out = filter.push(held);
      held = "";
      if (out !== "") {
        emitted += out.length;
        yield { type: "delta", text: out };
      }
    }

    // Release the sentence held back above, minus any trailing filler.
    if (decided) {
      const tail = filter.flush();
      if (tail !== "") {
        emitted += tail.length;
        yield { type: "delta", text: tail };
      }
    }

    let toolCall = null;
    if (!decided) {
      toolCall = useTools ? parseToolCall(held) : null;
      if (toolCall === null && held !== "") {
        // It looked like a tool call but was not one after all.
        const cleaned = stripTrailingFiller(held);
        if (cleaned !== "") {
          emitted += cleaned.length;
          yield { type: "delta", text: cleaned };
        }
      }
    }

    if (toolCall === null) {
      finishReason = emitted > 0 ? "stop" : "empty";
      break;
    }

    if (steps >= maxSteps) {
      yield {
        type: "delta",
        text: `\n\n(Stopped: reached the ${maxSteps}-step limit before finishing.)`,
      };
      finishReason = "max_steps";
      break;
    }

    const id = randomUUID();
    const tool = registry.get(toolCall.name);
    const decision = decide(tool, context);
    const signature = `${toolCall.name}:${JSON.stringify(toolCall.args)}`;

    yield {
      type: "tool_call",
      id,
      name: toolCall.name,
      risk: tool?.risk ?? "read",
      args: toolCall.args,
      allowed: decision.allowed,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };

    let result: ToolResult;
    if (!tool) {
      result = { ok: false, verified: false, summary: `There is no tool named "${toolCall.name}".` };
    } else if (!decision.allowed) {
      result = { ok: false, verified: false, summary: decision.reason ?? "Refused." };
    } else if (executed.has(signature)) {
      // Small local models often repeat an identical call. The first result is
      // already in the transcript, so repeating it only wastes a step.
      result = {
        ok: false,
        verified: false,
        summary: `You already called ${toolCall.name} with these exact arguments; the result is above. Use that result instead of repeating the call.`,
      };
    } else {
      executed.add(signature);
      result = await tool.run(toolCall.args, context);
    }

    outcomes.push({
      name: toolCall.name,
      ok: result.ok,
      verified: result.verified === true,
      summary: result.summary,
    });

    yield {
      type: "tool_result",
      id,
      name: toolCall.name,
      ok: result.ok,
      verified: result.verified === true,
      summary: result.summary,
    };

    messages.push({
      role: "assistant",
      content: JSON.stringify({ tool: toolCall.name, args: toolCall.args }),
    });
    messages.push({
      role: "user",
      content: `TOOL RESULT (${toolCall.name}) ok=${result.ok}${
        result.verified ? " verified=true" : ""
      }:\n${result.summary}`,
    });
  }

  if (options.review && mode === "agent") {
    const reviewMessages: ChatMessage[] = [
      { role: "system", content: buildReviewPrompt() },
      {
        role: "user",
        content: `Tool outcomes:\n${summarizeToolOutcomes(outcomes)}\n\nConversation:\n${condense(messages)}`,
      },
    ];

    for await (const event of provider.streamChat({ messages: reviewMessages, signal, model })) {
      // The verifier's token usage is not the agent turn's usage, so it is not
      // folded into the `done` event.
      if (event.type === "delta") yield { type: "review", text: event.text };
    }
  }

  yield {
    type: "done",
    finishReason,
    steps,
    ...(usage === undefined ? {} : { usage }),
  };
}

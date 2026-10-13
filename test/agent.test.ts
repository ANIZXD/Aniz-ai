import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { runAgent, type AgentEvent, type RunAgentOptions } from "../src/agent/agent.ts";
import { hasVerifiedEffect, summarizeToolOutcomes } from "../src/agent/verifier.ts";
import type { ProviderAdapter } from "../src/providers/types.ts";
import { createDefaultTools } from "../src/tools/index.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { createScriptedAdapter } from "./helpers.ts";

const registry = createToolRegistry(createDefaultTools());

let workspaceDir = "";

before(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), "anizai-agent-"));
  await writeFile(path.join(workspaceDir, "notes.txt"), "hello world\n", "utf8");
});

after(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceDir, allowWrite: false, allowDestructive: false, ...overrides };
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function doneEvent(events: AgentEvent[]): Extract<AgentEvent, { type: "done" }> {
  const done = events.find((event) => event.type === "done");
  assert.ok(done, "expected a done event");
  return done;
}

function toolResults(events: AgentEvent[]): Extract<AgentEvent, { type: "tool_result" }>[] {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result",
  );
}

function base(provider: ProviderAdapter, overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
  return {
    provider,
    registry,
    history: [{ role: "user", content: "Hello" }],
    mode: "chat",
    role: "assistant",
    review: false,
    context: context(),
    maxSteps: 6,
    ...overrides,
  };
}

describe("runAgent in chat mode", () => {
  test("streams the reply and finishes", async () => {
    const provider = createScriptedAdapter(["Hi there, how can I help?"]);
    const events = await collect(runAgent(base(provider)));

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, "Hi there, how can I help?");

    const done = doneEvent(events);
    assert.equal(done.finishReason, "stop");
    assert.equal(done.steps, 1);
  });

  test("always sends a system prompt first", async () => {
    const provider = createScriptedAdapter(["ok"]);
    await collect(runAgent(base(provider)));

    assert.equal(provider.calls[0]?.[0]?.role, "system");
    assert.match(provider.calls[0]?.[0]?.content ?? "", /ANIZ AI/);
    assert.equal(provider.calls[0]?.[1]?.content, "Hello");
  });

  test("reports an empty reply as an empty finish", async () => {
    const provider = createScriptedAdapter([""]);
    const events = await collect(runAgent(base(provider)));

    assert.equal(doneEvent(events).finishReason, "empty");
  });

  test("does not treat a JSON-looking reply as a tool call in chat mode", async () => {
    const provider = createScriptedAdapter(['{"answer": 42}']);
    const events = await collect(runAgent(base(provider)));

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, '{"answer": 42}');
    assert.equal(toolResults(events).length, 0);
  });
});

describe("runAgent in plan mode", () => {
  test("asks for a plan and uses no tools", async () => {
    const provider = createScriptedAdapter(["1. Read the file\n2. Summarise it"]);
    const events = await collect(runAgent(base(provider, { mode: "plan" })));

    assert.match(provider.calls[0]?.[0]?.content ?? "", /numbered plan/);
    assert.doesNotMatch(provider.calls[0]?.[0]?.content ?? "", /Available tools/);
    assert.equal(doneEvent(events).finishReason, "stop");
  });
});

describe("runAgent in agent mode", () => {
  test("instructs the model about the tool protocol", async () => {
    const provider = createScriptedAdapter(["Done."]);
    await collect(runAgent(base(provider, { mode: "agent" })));

    const system = provider.calls[0]?.[0]?.content ?? "";
    assert.match(system, /Available tools/);
    assert.match(system, /read_file/);
    assert.match(system, /Never invent a tool result/);
  });

  test("runs a tool, feeds the result back, then answers", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "read_file", "args": {"path": "notes.txt"}}',
      "The file says hello world.",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    const call = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call",
    );
    assert.ok(call);
    assert.equal(call.name, "read_file");
    assert.equal(call.risk, "read");
    assert.equal(call.allowed, true);

    const [result] = toolResults(events);
    assert.equal(result?.ok, true);
    assert.equal(result?.verified, false, "reads are not verified effects");
    assert.match(result?.summary ?? "", /hello world/);

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, "The file says hello world.");

    // The tool output reached the model, and it did not leak to the user.
    const secondCall = provider.calls[1] ?? [];
    const toolMessage = secondCall.find((message) => message.content.startsWith("TOOL RESULT"));
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /TOOL RESULT \(read_file\) ok=true/);
    assert.match(toolMessage.content, /hello world/);
    assert.doesNotMatch(text, /TOOL RESULT/);

    assert.equal(doneEvent(events).steps, 2);
  });

  test("accepts a fenced tool call", async () => {
    const provider = createScriptedAdapter([
      '```json\n{"tool": "list_files", "args": {"path": "."}}\n```',
      "Here they are.",
    ]);
    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    assert.equal(toolResults(events)[0]?.ok, true);
    assert.equal(doneEvent(events).steps, 2);
  });

  test("stops early when the model replies with prose", async () => {
    const provider = createScriptedAdapter(["Nothing to do."]);
    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    assert.equal(provider.calls.length, 1);
    assert.equal(toolResults(events).length, 0);
  });

  test("handles an unknown tool without crashing", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "make_coffee", "args": {}}',
      "I could not do that.",
    ]);
    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    const [result] = toolResults(events);
    assert.equal(result?.ok, false);
    assert.match(result?.summary ?? "", /no tool named "make_coffee"/i);
    assert.equal(doneEvent(events).steps, 2);
  });

  test("refuses a write when file edits are off, and does not touch the disk", async () => {
    const target = path.join(workspaceDir, "should-not-exist.txt");
    const provider = createScriptedAdapter([
      `{"tool": "write_file", "args": {"path": "should-not-exist.txt", "content": "hi"}}`,
      "I was not allowed to write the file.",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    const call = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call",
    );
    assert.equal(call?.allowed, false);
    assert.match(call?.reason ?? "", /not enabled/);

    const [result] = toolResults(events);
    assert.equal(result?.ok, false);
    assert.equal(result?.verified, false);

    await assert.rejects(stat(target));
  });

  test("allows and verifies a write when file edits are on", async () => {
    const provider = createScriptedAdapter([
      `{"tool": "write_file", "args": {"path": "out/report.txt", "content": "all good\\n"}}`,
      "Written and verified.",
    ]);

    const events = await collect(
      runAgent(base(provider, { mode: "agent", context: context({ allowWrite: true }) })),
    );

    const [result] = toolResults(events);
    assert.equal(result?.ok, true);
    assert.equal(result?.verified, true, "the write must be confirmed by reading it back");

    const onDisk = await readFile(path.join(workspaceDir, "out", "report.txt"), "utf8");
    assert.equal(onDisk, "all good\n");
  });

  test("keeps deleting refused even when writes are allowed", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "delete_file", "args": {"path": "notes.txt"}}',
      "I did not delete it.",
    ]);

    const events = await collect(
      runAgent(base(provider, { mode: "agent", context: context({ allowWrite: true }) })),
    );

    const call = events.find(
      (event): event is Extract<AgentEvent, { type: "tool_call" }> => event.type === "tool_call",
    );
    assert.equal(call?.allowed, false);
    assert.equal(toolResults(events)[0]?.ok, false);

    const stillThere = await stat(path.join(workspaceDir, "notes.txt"));
    assert.ok(stillThere.isFile());
  });

  test("stops at the step limit instead of looping forever", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "list_files", "args": {"path": "."}}',
      '{"tool": "list_files", "args": {"path": "."}}',
      '{"tool": "list_files", "args": {"path": "."}}',
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent", maxSteps: 2 })));

    const done = doneEvent(events);
    assert.equal(done.finishReason, "max_steps");
    assert.equal(done.steps, 2);

    const note = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.match(note, /step limit/);
  });

  test("does not run an identical repeated tool call twice", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "list_files", "args": {"path": "."}}',
      '{"tool": "list_files", "args": {"path": "."}}',
      "Done looking.",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    const results = toolResults(events);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false, "the duplicate call must not be executed again");
    assert.match(results[1]?.summary ?? "", /already called list_files/i);
    assert.equal(doneEvent(events).steps, 3);
  });

  test("still allows a different call to the same tool", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "read_file", "args": {"path": "notes.txt"}}',
      '{"tool": "list_files", "args": {"path": "."}}',
      "Both done.",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent" })));
    const results = toolResults(events);

    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.ok));
  });

  test("treats a brace-leading reply that is not a tool call as prose", async () => {
    const provider = createScriptedAdapter(['{ "answer": "yes" } is my reply']);
    const events = await collect(runAgent(base(provider, { mode: "agent" })));

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, '{ "answer": "yes" } is my reply');
    assert.equal(toolResults(events).length, 0);
  });
});

describe("runAgent reply styling", () => {
  test("strips a trailing offer of help from the streamed reply", async () => {
    const provider = createScriptedAdapter([
      "The file has three lines.\n\nHow can I assist you today?",
    ]);

    const events = await collect(runAgent(base(provider)));

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");

    assert.equal(text, "The file has three lines.\n\n");
    assert.doesNotMatch(text, /assist/i);
  });

  test("still reports an empty finish when the whole reply was filler", async () => {
    const provider = createScriptedAdapter(["How can I help you?"]);
    const events = await collect(runAgent(base(provider)));

    assert.equal(doneEvent(events).finishReason, "empty");
  });

  test("keeps streamed replies that have no filler", async () => {
    const provider = createScriptedAdapter(["Two plus two is four."]);
    const events = await collect(runAgent(base(provider)));

    const text = events
      .filter((event): event is Extract<AgentEvent, { type: "delta" }> => event.type === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(text, "Two plus two is four.");
  });
});

describe("runAgent verifier pass", () => {
  test("runs the reviewer after the agent finishes", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "read_file", "args": {"path": "notes.txt"}}',
      "The file says hello world.",
      "Outcome: done\nEvidence: read_file ok=true",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent", review: true })));

    const review = events
      .filter((event): event is Extract<AgentEvent, { type: "review" }> => event.type === "review")
      .map((event) => event.text)
      .join("");
    assert.match(review, /Outcome: done/);

    // The verifier is told what the tools actually reported.
    const reviewCall = provider.calls[2] ?? [];
    assert.match(reviewCall[0]?.content ?? "", /verifier/i);
    assert.match(reviewCall[1]?.content ?? "", /read_file: ok, unverified/);

    // Done is always last.
    assert.equal(events.at(-1)?.type, "done");
  });

  test("does not run the reviewer in chat mode", async () => {
    const provider = createScriptedAdapter(["just an answer"]);
    const events = await collect(runAgent(base(provider, { review: true })));

    assert.equal(provider.calls.length, 1);
    assert.equal(events.some((event) => event.type === "review"), false);
  });

  test("keeps the agent turn's usage rather than the reviewer's", async () => {
    const provider = createScriptedAdapter([
      '{"tool": "list_files", "args": {"path": "."}}',
      "Here they are.",
      "Outcome: done",
    ]);

    const events = await collect(runAgent(base(provider, { mode: "agent", review: true })));

    // The scripted adapter reports its call number as usage: the agent made two
    // calls (tool call, then prose), so the done event must say 2 — not 3, which
    // would mean the verifier's usage leaked into it.
    const done = doneEvent(events);
    assert.equal(done.usage?.promptTokens, 2);
    assert.match(
      events
        .filter((event): event is Extract<AgentEvent, { type: "review" }> => event.type === "review")
        .map((event) => event.text)
        .join(""),
      /Outcome: done/,
    );
  });
});

describe("runAgent cancellation", () => {
  test("stops without yielding when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = createScriptedAdapter(["never seen"]);
    const events = await collect(runAgent(base(provider, { signal: controller.signal })));

    assert.deepEqual(events, []);
    assert.equal(provider.calls.length, 0);
  });
});

describe("verifier helpers", () => {
  test("summarises outcomes and distinguishes verified effects", () => {
    const outcomes = [
      { name: "read_file", ok: true, verified: false, summary: "Contents of notes.txt:\nhello" },
      { name: "write_file", ok: true, verified: true, summary: "Wrote \"a.txt\". Verified." },
      { name: "delete_file", ok: false, verified: false, summary: "Refused: deleting is never automatic." },
    ];

    const summary = summarizeToolOutcomes(outcomes);
    assert.match(summary, /- read_file: ok, unverified — Contents of notes\.txt/);
    assert.match(summary, /- write_file: ok, verified/);
    assert.match(summary, /- delete_file: failed/);

    assert.equal(hasVerifiedEffect(outcomes), true);
    assert.equal(summarizeToolOutcomes([]), "No tools were used.");
  });
});

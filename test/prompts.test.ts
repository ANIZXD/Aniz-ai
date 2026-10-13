import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSystemPrompt } from "../src/agent/prompts.ts";

const BASE = { mode: "chat", role: "assistant", tools: "" } as const;

describe("system prompt", () => {
  test("states its identity once", () => {
    const prompt = buildSystemPrompt(BASE);
    const mentions = prompt.match(/You are ANIZ AI/g) ?? [];
    assert.equal(mentions.length, 1);
  });

  test("bans the canned closing offers", () => {
    const prompt = buildSystemPrompt(BASE);
    assert.match(prompt, /Never close with an offer of help/);
    assert.match(prompt, /How may I assist you\?/);
  });

  test("tells it to engage with pushback rather than repeat itself", () => {
    const prompt = buildSystemPrompt(BASE);
    assert.match(prompt, /Never reuse a sentence/);
    assert.match(prompt, /engage with that exact point/);
    assert.match(prompt, /be interested rather than defensive/);
  });

  test("keeps the untrusted-data rule in every mode", () => {
    for (const mode of ["chat", "agent", "plan"] as const) {
      assert.match(buildSystemPrompt({ ...BASE, mode }), /untrusted data/);
    }
  });
});

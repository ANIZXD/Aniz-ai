import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { historyForModel } from "../src/routes/chat.ts";
import type { ChatMessage } from "../src/providers/types.ts";

const TRANSCRIPT: ChatMessage[] = [
  { role: "user", content: "you have no creator" },
  { role: "assistant", content: "I don't have a creator - I'm just here to help!" },
  { role: "user", content: "you have 1" },
];

describe("chat history", () => {
  test("hides the model's own replies so it cannot parrot them", () => {
    const history = historyForModel(TRANSCRIPT, "chat", "user");
    assert.deepEqual(history, [
      { role: "user", content: "you have no creator" },
      { role: "user", content: "you have 1" },
    ]);
  });

  test("keeps the whole transcript when configured to", () => {
    assert.equal(historyForModel(TRANSCRIPT, "chat", "full"), TRANSCRIPT);
  });

  test("always keeps the transcript in agent and plan modes", () => {
    for (const mode of ["agent", "plan"] as const) {
      assert.equal(historyForModel(TRANSCRIPT, mode, "user").length, 3);
    }
  });
});

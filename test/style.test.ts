import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTrailingFilter, stripTrailingFiller } from "../src/agent/style.ts";

describe("stripTrailingFiller", () => {
  test("removes a trailing offer of help", () => {
    assert.equal(
      stripTrailingFiller("The file says hello world. How can I assist you today?"),
      "The file says hello world.",
    );
  });

  test("removes the common variants", () => {
    const cases = [
      "Done.\n\nIs there anything else I can help you with?",
      "Done.\nLet me know if you need anything else.",
      "Done. Feel free to ask if you have questions.",
      "Done. Happy to help.",
      "Done. I'm here to help if you need anything.",
      "Done. Do you have any other questions?",
      "Done. Just let me know.",
      "Done. Hope that helps!",
      "Done. What would you like me to do next?",
    ];

    for (const input of cases) {
      assert.equal(stripTrailingFiller(input), "Done.", `failed on: ${input}`);
    }
  });

  test("removes several filler sentences in a row", () => {
    assert.equal(
      stripTrailingFiller("All set.\nLet me know if you need anything.\nHow can I help you?"),
      "All set.",
    );
  });

  test("removes a filler bullet", () => {
    assert.equal(stripTrailingFiller("Here you go.\n- How can I help you?"), "Here you go.");
  });

  test("keeps a real answer intact", () => {
    const answer = "The answer is 42 because the compiler rounds up.";
    assert.equal(stripTrailingFiller(answer), answer);
  });

  test("keeps content that only mentions helping", () => {
    const answer = "I can help you with the file once you enable file edits.";
    assert.equal(stripTrailingFiller(answer), answer);
  });

  test("does not eat a long sentence that merely starts with 'happy to help'", () => {
    const answer =
      "Happy to help is what the doc file calls this section, so that is the heading you want.";
    assert.equal(stripTrailingFiller(answer), answer);
  });

  test("returns an empty string when the whole reply is filler", () => {
    assert.equal(stripTrailingFiller("How can I assist you today?"), "");
  });
});

describe("createTrailingFilter (streaming)", () => {
  test("releases text once a sentence is complete", () => {
    const filter = createTrailingFilter();
    assert.equal(filter.push("Hello there."), "Hello there.");
    // No terminator yet, so this is held back.
    assert.equal(filter.push(" This is more"), "");
    assert.equal(filter.push(" text."), " This is more text.");
    assert.equal(filter.flush(), "");
  });

  test("never releases trailing filler, however it is chunked", () => {
    const chunks = ["Sure. ", "How can ", "I assist ", "you today", "?"];
    const filter = createTrailingFilter();
    let out = "";
    for (const chunk of chunks) out += filter.push(chunk);
    out += filter.flush();

    assert.equal(out, "Sure.");
  });

  test("holds back an incomplete final sentence until flush", () => {
    const filter = createTrailingFilter();
    assert.equal(filter.push("no punctuation yet"), "");
    assert.equal(filter.flush(), "no punctuation yet");
  });

  test("round-trips a normal reply unchanged", () => {
    const text = "Line one.\nLine two is longer.\n\nAnd a final line.";
    const filter = createTrailingFilter();
    let out = "";
    for (const part of text.match(/[\s\S]{1,4}/g) ?? []) out += filter.push(part);
    out += filter.flush();
    assert.equal(out, text);
  });
});

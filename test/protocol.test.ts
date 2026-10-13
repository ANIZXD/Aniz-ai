import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { looksUndecided, parseToolCall } from "../src/agent/protocol.ts";

describe("parseToolCall", () => {
  test("parses a bare tool call", () => {
    const call = parseToolCall('{"tool": "read_file", "args": {"path": "notes.txt"}}');
    assert.deepEqual(call, { name: "read_file", args: { path: "notes.txt" } });
  });

  test("parses a fenced tool call", () => {
    const call = parseToolCall('```json\n{"tool": "list_files", "args": {}}\n```');
    assert.deepEqual(call, { name: "list_files", args: {} });
  });

  test("extracts a tool call surrounded by chatter", () => {
    const call = parseToolCall('Sure, let me look.\n{"tool": "search_files", "args": {"query": "x"}}\n');
    assert.equal(call?.name, "search_files");
  });

  test("accepts name and arguments as aliases", () => {
    const call = parseToolCall('{"name": "read_file", "arguments": {"path": "a.txt"}}');
    assert.deepEqual(call, { name: "read_file", args: { path: "a.txt" } });
  });

  test("treats a missing args field as empty", () => {
    assert.deepEqual(parseToolCall('{"tool": "list_files"}'), { name: "list_files", args: {} });
  });

  test("keeps nested braces inside argument strings", () => {
    const call = parseToolCall('{"tool": "write_file", "args": {"path": "a.json", "content": "{\\"a\\": 1}"}}');
    assert.equal(call?.name, "write_file");
    assert.equal(call?.args.content, '{"a": 1}');
  });

  test("returns null for plain prose", () => {
    assert.equal(parseToolCall("The answer is 42."), null);
  });

  test("returns null for prose containing a brace", () => {
    assert.equal(parseToolCall("Use {curly braces} carefully."), null);
  });

  test("returns null for an object without a tool name", () => {
    assert.equal(parseToolCall('{"args": {"path": "a.txt"}}'), null);
  });

  test("returns null when args is not an object", () => {
    assert.equal(parseToolCall('{"tool": "read_file", "args": [1, 2]}'), null);
  });

  test("returns null for invalid JSON", () => {
    assert.equal(parseToolCall('{"tool": "read_file", '), null);
  });

  test("returns null for empty input", () => {
    assert.equal(parseToolCall(""), null);
    assert.equal(parseToolCall("   "), null);
  });
});

describe("looksUndecided", () => {
  test("stays undecided while the reply could still be a tool call", () => {
    assert.equal(looksUndecided(""), true);
    assert.equal(looksUndecided("  \n"), true);
    assert.equal(looksUndecided("{"), true);
    assert.equal(looksUndecided('{"tool"'), true);
    assert.equal(looksUndecided("```json"), true);
  });

  test("decides as soon as the reply is clearly prose", () => {
    assert.equal(looksUndecided("H"), false);
    assert.equal(looksUndecided("Here you go"), false);
  });
});

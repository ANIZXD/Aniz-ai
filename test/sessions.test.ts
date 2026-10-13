import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createSessionStore, type SessionStore } from "../src/sessions/store.ts";
import { titleFromMessage } from "../src/sessions/types.ts";

async function withStore(
  run: (context: { file: string; store: SessionStore }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "anizai-store-"));
  const file = path.join(dir, "sessions.json");
  try {
    await run({ file, store: createSessionStore(file) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("titleFromMessage", () => {
  test("uses the first line, trimmed", () => {
    assert.equal(titleFromMessage("  Fix the parser\nmore detail"), "Fix the parser");
  });

  test("collapses whitespace", () => {
    assert.equal(titleFromMessage("hello    world"), "hello world");
  });

  test("truncates long titles with an ellipsis", () => {
    const title = titleFromMessage("x".repeat(80));
    assert.equal(title.length, 48);
    assert.ok(title.endsWith("…"));
  });

  test("returns an empty title for blank input", () => {
    assert.equal(titleFromMessage("   \n  "), "");
  });
});

describe("session store", () => {
  test("creates, appends and reads back a session", async () => {
    await withStore(async ({ store }) => {
      const created = await store.create();
      assert.equal(created.title, "");
      assert.equal(created.messages.length, 0);

      const updated = await store.append(created.id, { role: "user", content: "What is 2+2?" });
      assert.ok(updated);
      assert.equal(updated.messages.length, 1);
      assert.equal(updated.messages[0]?.role, "user");

      const fetched = await store.get(created.id);
      assert.equal(fetched?.messages[0]?.content, "What is 2+2?");
    });
  });

  test("names a session after its first user message", async () => {
    await withStore(async ({ store }) => {
      const created = await store.create();
      const updated = await store.append(created.id, {
        role: "user",
        content: "Explain the build system\nand also the tests",
      });
      assert.equal(updated?.title, "Explain the build system");

      // Later messages must not rename it.
      const again = await store.append(created.id, { role: "user", content: "Another question" });
      assert.equal(again?.title, "Explain the build system");
    });
  });

  test("returns null when appending to an unknown session", async () => {
    await withStore(async ({ store }) => {
      assert.equal(await store.append("does-not-exist", { role: "user", content: "hi" }), null);
      assert.equal(await store.get("nope"), null);
    });
  });

  test("lists sessions newest first with message counts", async () => {
    await withStore(async ({ store }) => {
      const first = await store.create("First");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.create("Second");
      await store.append(second.id, { role: "user", content: "hi" });

      const list = await store.list();
      assert.equal(list.length, 2);
      assert.equal(list[0]?.id, second.id);
      assert.equal(list[0]?.messageCount, 1);
      assert.equal(list[1]?.id, first.id);
    });
  });

  test("renames and deletes sessions", async () => {
    await withStore(async ({ store }) => {
      const created = await store.create("Old name");
      const renamed = await store.rename(created.id, "  New name  ");
      assert.equal(renamed?.title, "New name");

      assert.equal(await store.remove(created.id), true);
      assert.equal(await store.remove(created.id), false);
      assert.equal(await store.get(created.id), null);
    });
  });

  test("survives a restart by reading the same file", async () => {
    await withStore(async ({ file, store }) => {
      const created = await store.create();
      await store.append(created.id, { role: "user", content: "persist me" });

      const reloaded = createSessionStore(file);
      const session = await reloaded.get(created.id);
      assert.equal(session?.messages[0]?.content, "persist me");
    });
  });

  test("serialises concurrent appends without losing messages", async () => {
    await withStore(async ({ store }) => {
      const created = await store.create();
      await Promise.all(
        Array.from({ length: 12 }, (_value, index) =>
          store.append(created.id, { role: "user", content: `message ${index}` }),
        ),
      );

      const session = await store.get(created.id);
      assert.equal(session?.messages.length, 12);
    });
  });

  test("moves a corrupt file aside instead of losing the app", async () => {
    await withStore(async ({ file, store }) => {
      await writeFile(file, "{ this is not json", "utf8");

      const list = await store.list();
      assert.deepEqual(list, []);

      // The bad file is preserved for recovery.
      const entries = await store.create("After recovery");
      assert.equal(entries.title, "After recovery");

      const raw = await readFile(file, "utf8");
      assert.match(raw, /After recovery/);
    });
  });
});

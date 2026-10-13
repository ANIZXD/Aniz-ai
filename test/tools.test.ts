import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { writeFile, mkdir } from "node:fs/promises";
import { createDefaultTools } from "../src/tools/index.ts";
import { createBrowserTools } from "../src/tools/browser.ts";
import { createToolRegistry } from "../src/tools/registry.ts";
import type { Tool, ToolContext } from "../src/tools/types.ts";

const READ_ONLY: Pick<ToolContext, "allowWrite" | "allowDestructive"> = {
  allowWrite: false,
  allowDestructive: false,
};

async function withWorkspace(
  run: (context: { workspaceDir: string; tools: Map<string, Tool>; context: ToolContext }) => Promise<void>,
): Promise<void> {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), "anizai-ws-"));

  await mkdir(path.join(workspaceDir, "src"), { recursive: true });
  await mkdir(path.join(workspaceDir, "node_modules"), { recursive: true });
  await writeFile(path.join(workspaceDir, "notes.txt"), "hello world\nsecond line\n", "utf8");
  await writeFile(path.join(workspaceDir, "src", "app.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(path.join(workspaceDir, "node_modules", "skip.txt"), "hello from a dependency\n", "utf8");

  const tools = new Map(createDefaultTools().map((tool) => [tool.name, tool]));
  const context: ToolContext = { workspaceDir, ...READ_ONLY };

  try {
    await run({ workspaceDir, tools, context });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

function tool(tools: Map<string, Tool>, name: string): Tool {
  const found = tools.get(name);
  assert.ok(found, `expected a tool named ${name}`);
  return found;
}

describe("workspace path safety", () => {
  test("refuses to read outside the workspace", async () => {
    await withWorkspace(async ({ tools, context }) => {
      for (const candidate of ["../secrets.txt", "src/../../escape.txt", "C:/Windows/win.ini"]) {
        const result = await tool(tools, "read_file").run({ path: candidate }, context);
        assert.equal(result.ok, false, `expected ${candidate} to be refused`);
      }
    });
  });

  test("refuses to write outside the workspace even when writes are allowed", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "write_file").run(
        { path: "../escape.txt", content: "nope" },
        { ...context, allowWrite: true },
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /outside the workspace/);
    });
  });
});

describe("read tools", () => {
  test("list_files lists a folder and marks directories", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "list_files").run({ path: "." }, context);
      assert.equal(result.ok, true);
      assert.match(result.summary, /notes\.txt/);
      assert.match(result.summary, /src\//);
    });
  });

  test("list_files is not recursive unless asked", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const shallow = await tool(tools, "list_files").run({ path: "." }, context);
      assert.doesNotMatch(shallow.summary, /app\.ts/);

      const deep = await tool(tools, "list_files").run({ path: ".", recursive: true }, context);
      assert.match(deep.summary, /src\/app\.ts/);
    });
  });

  test("list_files never descends into node_modules", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "list_files").run({ path: ".", recursive: true }, context);
      assert.doesNotMatch(result.summary, /skip\.txt/);
    });
  });

  test("treats an empty path as the workspace root", async () => {
    await withWorkspace(async ({ tools, context }) => {
      // Models commonly send "" to mean "here".
      const listing = await tool(tools, "list_files").run({ path: "" }, context);
      assert.equal(listing.ok, true);
      assert.match(listing.summary, /notes\.txt/);

      const search = await tool(tools, "search_files").run({ query: "answer", path: "" }, context);
      assert.equal(search.ok, true);
      assert.match(search.summary, /src\/app\.ts/);
    });
  });

  test("read_file returns the contents", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "read_file").run({ path: "notes.txt" }, context);
      assert.equal(result.ok, true);
      assert.match(result.summary, /hello world/);
      assert.match(result.summary, /second line/);
    });
  });

  test("read_file explains a missing file instead of throwing", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "read_file").run({ path: "nope.txt" }, context);
      assert.equal(result.ok, false);
      assert.match(result.summary, /no file/);
    });
  });

  test("read_file requires its path argument", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "read_file").run({}, context);
      assert.equal(result.ok, false);
      assert.match(result.summary, /"path" is required/);
    });
  });

  test("read_file strips a leading byte-order mark", async () => {
    await withWorkspace(async ({ workspaceDir, tools, context }) => {
      await writeFile(path.join(workspaceDir, "bom.txt"), "\uFEFFfirst line\n", "utf8");
      const result = await tool(tools, "read_file").run({ path: "bom.txt" }, context);
      assert.equal(result.ok, true);
      assert.match(result.summary, /Contents of "bom\.txt":\nfirst line/);
      assert.doesNotMatch(result.summary, /\uFEFF/);
    });
  });

  test("read_file refuses a folder", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "read_file").run({ path: "src" }, context);
      assert.equal(result.ok, false);
      assert.match(result.summary, /folder/);
    });
  });

  test("search_files reports file and line numbers", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "search_files").run({ query: "answer" }, context);
      assert.equal(result.ok, true);
      assert.match(result.summary, /src\/app\.ts:1:/);
    });
  });

  test("search_files says so when nothing matches", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "search_files").run({ query: "zzzz" }, context);
      assert.equal(result.ok, true);
      assert.match(result.summary, /No matches/);
    });
  });
});

describe("write tools (supervised)", () => {
  test("write_file is refused while file edits are off", async () => {
    await withWorkspace(async ({ workspaceDir, tools, context }) => {
      const result = await tool(tools, "write_file").run(
        { path: "new.txt", content: "hello" },
        context,
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /not enabled/);

      // Nothing was created behind the user's back.
      await assert.rejects(stat(path.join(workspaceDir, "new.txt")));
    });
  });

  test("write_file writes and verifies the content when allowed", async () => {
    await withWorkspace(async ({ workspaceDir, tools, context }) => {
      const result = await tool(tools, "write_file").run(
        { path: "reports/summary.md", content: "# Report\n\nAll good.\n" },
        { ...context, allowWrite: true },
      );

      assert.equal(result.ok, true);
      assert.equal(result.verified, true, "the write should be read back and confirmed");
      assert.match(result.summary, /Verified/);

      const onDisk = await readFile(path.join(workspaceDir, "reports", "summary.md"), "utf8");
      assert.equal(onDisk, "# Report\n\nAll good.\n");
    });
  });

  test("write_file accepts empty content but not a missing content field", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const empty = await tool(tools, "write_file").run(
        { path: "empty.txt", content: "" },
        { ...context, allowWrite: true },
      );
      assert.equal(empty.ok, true);

      const missing = await tool(tools, "write_file").run(
        { path: "x.txt" },
        { ...context, allowWrite: true },
      );
      assert.equal(missing.ok, false);
      assert.match(missing.summary, /"content" is required/);
    });
  });

  test("delete_file is refused unless deletion is explicitly allowed", async () => {
    await withWorkspace(async ({ workspaceDir, tools, context }) => {
      const result = await tool(tools, "delete_file").run({ path: "notes.txt" }, context);
      assert.equal(result.ok, false);
      assert.match(result.summary, /never automatic/);

      const stillThere = await stat(path.join(workspaceDir, "notes.txt"));
      assert.ok(stillThere.isFile());
    });
  });

  test("delete_file removes a file and verifies it is gone", async () => {
    await withWorkspace(async ({ workspaceDir, tools, context }) => {
      const result = await tool(tools, "delete_file").run(
        { path: "notes.txt" },
        { ...context, allowDestructive: true },
      );
      assert.equal(result.ok, true);
      assert.equal(result.verified, true);
      await assert.rejects(stat(path.join(workspaceDir, "notes.txt")));
    });
  });

  test("delete_file refuses to remove the workspace root", async () => {
    await withWorkspace(async ({ tools, context }) => {
      const result = await tool(tools, "delete_file").run(
        { path: "." },
        { ...context, allowDestructive: true },
      );
      assert.equal(result.ok, false);
      assert.match(result.summary, /workspace root/);
    });
  });
});

describe("tool registry", () => {
  test("describes every tool with its arguments and risk", () => {
    const registry = createToolRegistry(createDefaultTools());
    const description = registry.describe();

    assert.match(description, /- read_file\(path: string, maxBytes\?: number\) \[read\]/);
    assert.match(description, /- write_file\(path: string, content: string\) \[write\]/);
    assert.match(description, /\[destructive\]/);
  });

  test("reports availability for each tool", async () => {
    const registry = createToolRegistry(createDefaultTools());
    const report = await registry.availability();

    assert.ok(report.length >= 5);
    const read = report.find((entry) => entry.name === "read_file");
    assert.equal(read?.ok, true);
    assert.equal(read?.risk, "read");
  });

  test("returns undefined for an unknown tool", () => {
    const registry = createToolRegistry(createDefaultTools());
    assert.equal(registry.get("nope"), undefined);
  });
});

describe("browser tool (M6, opt-in)", () => {
  test("uses an attached driver and trims the page text", async () => {
    const [browse] = createBrowserTools({
      fetchPage: async (url) => ({ title: `Page at ${url}`, text: "line one\n\n\nline two" }),
    });
    assert.ok(browse);

    const result = await browse.run(
      { url: "https://example.com" },
      { workspaceDir: "", ...READ_ONLY },
    );

    assert.equal(result.ok, true);
    assert.match(result.summary, /Page at https:\/\/example\.com\//);
    assert.match(result.summary, /line one\n\nline two/);
  });

  test("explains a slow page instead of echoing a bare timeout", async () => {
    const [browse] = createBrowserTools({
      fetchPage: async () => {
        throw new Error("page.goto: Timeout 30000ms exceeded.");
      },
    });
    assert.ok(browse);

    const result = await browse.run(
      { url: "https://example.com" },
      { workspaceDir: "", ...READ_ONLY },
    );

    assert.equal(result.ok, false);
    assert.match(result.summary, /did not finish loading within 30s/);
    assert.doesNotMatch(result.summary, /Timeout 30000ms exceeded/);
  });

  test("only accepts http and https URLs", async () => {
    const [browse] = createBrowserTools({ fetchPage: async () => ({ title: "", text: "" }) });
    assert.ok(browse);

    const context: ToolContext = { workspaceDir: "", ...READ_ONLY };
    for (const url of ["ftp://example.com", "file:///etc/passwd", "not a url"]) {
      const result = await browse.run({ url }, context);
      assert.equal(result.ok, false, `expected ${url} to be refused`);
    }
  });

  test("honestly reports what is missing when it is not installed", async () => {
    const [browse] = createBrowserTools();
    assert.ok(browse);

    const availability = await browse.availability();
    assert.equal(typeof availability.ok, "boolean");
    if (!availability.ok) {
      assert.match(availability.detail, /Playwright|browser/);
    }
  });

  test("names the missing browser when no browser can be found", async () => {
    const [browse] = createBrowserTools();
    assert.ok(browse);
    const availability = await browse.availability();

    if (!availability.ok) {
      assert.match(availability.detail, /install chromium|Playwright is not installed/);
    }
  });
});

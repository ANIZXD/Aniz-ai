import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnsafePathError, resolveInRoot } from "../lib/pathSafe.ts";
import {
  BadArgsError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  requireStringAllowEmpty,
} from "./args.ts";
import { verifyFileAbsent, verifyFileContent } from "./verify.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";

const MAX_READ_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_WALK_DEPTH = 6;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function failure(message: string): ToolResult {
  return { ok: false, summary: message };
}

function success(summary: string, verified?: boolean): ToolResult {
  return verified === undefined ? { ok: true, summary } : { ok: true, summary, verified };
}

function describeError(error: unknown): string {
  if (error instanceof UnsafePathError || error instanceof BadArgsError) return error.message;

  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return "That file or folder does not exist.";
    case "EISDIR":
      return "That path is a folder, not a file.";
    case "ENOTDIR":
      return "A part of that path is a file, not a folder.";
    case "EPERM":
    case "EACCES":
      return "Permission denied for that path.";
    default:
      return error instanceof Error ? error.message : "The operation failed.";
  }
}

interface WalkEntry {
  relative: string;
  isDirectory: boolean;
  size: number;
}

async function* walk(
  root: string,
  base: string,
  depth: number,
  maxDepth: number,
): AsyncGenerator<WalkEntry> {
  const entries = await readdir(path.join(root, base), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

    const relative = base === "" ? entry.name : `${base}/${entry.name}`;

    if (entry.isDirectory()) {
      yield { relative, isDirectory: true, size: 0 };
      if (depth < maxDepth) yield* walk(root, relative, depth + 1, maxDepth);
      continue;
    }

    const info = await stat(path.join(root, relative)).catch(() => null);
    yield { relative, isDirectory: false, size: info?.size ?? 0 };
  }
}

function createListFilesTool(): Tool {
  return {
    name: "list_files",
    description: "List files and folders inside the workspace.",
    risk: "read",
    parameters: {
      path: { type: "string", description: "Folder to list, relative to the workspace. Defaults to the root." },
      recursive: { type: "boolean", description: "Include subfolders." },
    },
    availability: () => ({ ok: true, detail: "Ready." }),

    async run(args, context): Promise<ToolResult> {
      try {
        const relative = optionalString(args, "path") ?? ".";
        const recursive = optionalBoolean(args, "recursive", false);
        const start = resolveInRoot(context.workspaceDir, relative);

        const info = await stat(start).catch(() => null);
        if (info === null) return failure(`There is no folder at "${relative}" in the workspace.`);
        if (!info.isDirectory()) return failure(`"${relative}" is a file, not a folder.`);

        const lines: string[] = [];
        let capped = false;

        for await (const entry of walk(start, "", 1, recursive ? MAX_WALK_DEPTH : 1)) {
          lines.push(entry.isDirectory ? `${entry.relative}/` : `${entry.relative}  (${entry.size} bytes)`);
          if (lines.length >= MAX_LIST_ENTRIES) {
            capped = true;
            break;
          }
        }

        if (lines.length === 0) return success(`"${relative}" is empty.`);
        const note = capped ? `\n(stopped after ${MAX_LIST_ENTRIES} entries)` : "";
        return success(`Contents of "${relative}" (${lines.length} entries):\n${lines.join("\n")}${note}`);
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}

function createReadFileTool(): Tool {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    risk: "read",
    parameters: {
      path: { type: "string", description: "File to read, relative to the workspace.", required: true },
      maxBytes: { type: "number", description: `Maximum bytes to return (default ${MAX_READ_BYTES}).` },
    },
    availability: () => ({ ok: true, detail: "Ready." }),

    async run(args, context): Promise<ToolResult> {
      try {
        const relative = requireString(args, "path");
        const maxBytes = optionalNumber(args, "maxBytes", MAX_READ_BYTES, 1, MAX_READ_BYTES);
        const absolute = resolveInRoot(context.workspaceDir, relative);

        const info = await stat(absolute).catch(() => null);
        if (info === null) return failure(`There is no file at "${relative}".`);
        if (info.isDirectory()) return failure(`"${relative}" is a folder, not a file.`);

        const buffer = await readFile(absolute);
        if (buffer.includes(0)) {
          return failure(`"${relative}" looks like a binary file, so it was not read.`);
        }

        const truncated = buffer.length > maxBytes;
        // A leading byte-order mark is an encoding artifact, not content.
        const text = buffer.subarray(0, maxBytes).toString("utf8").replace(/^\uFEFF/, "");
        const header = truncated
          ? `First ${maxBytes} of ${buffer.length} bytes of "${relative}":`
          : `Contents of "${relative}":`;
        return success(`${header}\n${text}`);
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}

function createSearchFilesTool(): Tool {
  return {
    name: "search_files",
    description: "Search text files in the workspace for a substring (case-insensitive).",
    risk: "read",
    parameters: {
      query: { type: "string", description: "Text to look for.", required: true },
      path: { type: "string", description: "Folder to search in. Defaults to the workspace root." },
    },
    availability: () => ({ ok: true, detail: "Ready." }),

    async run(args, context): Promise<ToolResult> {
      try {
        const query = requireString(args, "query").toLowerCase();
        const relative = optionalString(args, "path") ?? ".";
        const start = resolveInRoot(context.workspaceDir, relative);

        const info = await stat(start).catch(() => null);
        if (info === null) return failure(`There is nothing at "${relative}" in the workspace.`);

        const isDirectory = info.isDirectory();
        const matches: string[] = [];
        const files = isDirectory
          ? walk(start, "", 1, MAX_WALK_DEPTH)
          : (async function* single(): AsyncGenerator<WalkEntry> {
              yield { relative: path.basename(start), isDirectory: false, size: info.size };
            })();

        for await (const entry of files) {
          if (entry.isDirectory) continue;
          if (entry.size > MAX_SEARCH_FILE_BYTES) continue;

          const absolute = isDirectory ? path.join(start, entry.relative) : start;
          const buffer = await readFile(absolute).catch(() => null);
          if (buffer === null || buffer.includes(0)) continue;

          const lines = buffer.toString("utf8").split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!line.toLowerCase().includes(query)) continue;
            matches.push(`${entry.relative}:${index + 1}: ${line.trim().slice(0, 200)}`);
            if (matches.length >= MAX_SEARCH_RESULTS) break;
          }
          if (matches.length >= MAX_SEARCH_RESULTS) break;
        }

        if (matches.length === 0) return success(`No matches for "${query}".`);
        return success(`${matches.length} match(es) for "${query}":\n${matches.join("\n")}`);
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}

function createWriteFileTool(): Tool {
  return {
    name: "write_file",
    description: "Create or overwrite a text file in the workspace.",
    risk: "write",
    parameters: {
      path: { type: "string", description: "File to write, relative to the workspace.", required: true },
      content: { type: "string", description: "Full text content for the file.", required: true },
    },
    availability: () => ({ ok: true, detail: "Ready." }),

    async run(args, context): Promise<ToolResult> {
      try {
        if (!context.allowWrite) {
          return failure(
            "Refused: file edits are not enabled for this request. Ask the user to turn on file edits.",
          );
        }

        const relative = requireString(args, "path");
        const content = requireStringAllowEmpty(args, "content");
        const absolute = resolveInRoot(context.workspaceDir, relative);

        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");

        const verification = await verifyFileContent(absolute, content);
        if (!verification.ok) {
          return {
            ok: false,
            verified: false,
            summary: `Wrote "${relative}" but could not verify it: ${verification.summary}`,
          };
        }

        return success(
          `Wrote "${relative}" (${Buffer.byteLength(content)} bytes). ${verification.summary}`,
          true,
        );
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}

function createDeleteFileTool(): Tool {
  return {
    name: "delete_file",
    description: "Delete a file or folder from the workspace. Destructive.",
    risk: "destructive",
    parameters: {
      path: { type: "string", description: "Path to delete, relative to the workspace.", required: true },
    },
    availability: () => ({ ok: true, detail: "Ready." }),

    async run(args, context): Promise<ToolResult> {
      try {
        if (!context.allowDestructive) {
          return failure(
            "Refused: deleting is never automatic. Ask the user to confirm deletion explicitly.",
          );
        }

        const relative = requireString(args, "path");
        const absolute = resolveInRoot(context.workspaceDir, relative);
        if (absolute === path.resolve(context.workspaceDir)) {
          return failure("Refused: the workspace root itself cannot be deleted.");
        }

        const info = await stat(absolute).catch(() => null);
        if (info === null) return failure(`There is nothing to delete at "${relative}".`);

        await rm(absolute, { recursive: info.isDirectory(), force: false });

        const verification = await verifyFileAbsent(absolute);
        if (!verification.ok) {
          return { ok: false, verified: false, summary: verification.summary };
        }

        return success(`Deleted "${relative}". ${verification.summary}`, true);
      } catch (error) {
        return failure(describeError(error));
      }
    },
  };
}

export function createFileTools(): Tool[] {
  return [
    createListFilesTool(),
    createReadFileTool(),
    createSearchFilesTool(),
    createWriteFileTool(),
    createDeleteFileTool(),
  ];
}

export type { ToolContext };

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.ts";

export interface JsonFile<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
}

/**
 * A single JSON file used as a small document store.
 *
 * - Writes are serialized, so concurrent callers cannot interleave.
 * - Writes are atomic: write a temp file, then rename over the target. A crash
 *   mid-write cannot leave a half-written file in place.
 * - A missing or unreadable file yields the default. A corrupt file is moved
 *   aside rather than silently overwritten, so the data is recoverable.
 */
export function createJsonFile<T>(filePath: string, createDefault: () => T): JsonFile<T> {
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Could not read the data file; using defaults", { file: filePath });
      }
      return createDefault();
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      logger.error("The data file is not valid JSON; moving it aside", {
        file: filePath,
        backup,
        reason: error instanceof Error ? error.message : "unknown",
      });
      await rename(filePath, backup).catch(() => undefined);
      return createDefault();
    }
  }

  function write(value: T): Promise<void> {
    const task = queue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temp, filePath);
    });
    // Keep the chain alive even if this write rejects.
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return { read, write };
}

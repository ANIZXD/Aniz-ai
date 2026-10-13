import { readFile, stat } from "node:fs/promises";

/**
 * M4: verification helpers. These confirm an observable outcome after an action
 * was taken, instead of trusting that it worked.
 */

export interface VerificationResult {
  ok: boolean;
  verified: boolean;
  summary: string;
}

/** Confirms a file exists with exactly the expected content. */
export async function verifyFileContent(
  absolutePath: string,
  expected: string,
): Promise<VerificationResult> {
  let actual: string;
  try {
    actual = await readFile(absolutePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      verified: false,
      summary: `Could not read the file back (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
    };
  }

  if (actual !== expected) {
    return {
      ok: false,
      verified: false,
      summary: "The file on disk does not match what was written.",
    };
  }

  return {
    ok: true,
    verified: true,
    summary: `Verified: read back ${Buffer.byteLength(actual)} bytes, contents match.`,
  };
}

/** Confirms a path no longer exists. */
export async function verifyFileAbsent(absolutePath: string): Promise<VerificationResult> {
  const info = await stat(absolutePath).catch(() => null);
  if (info === null) {
    return { ok: true, verified: true, summary: "Verified: the path is gone." };
  }
  return { ok: false, verified: false, summary: "The path still exists after deletion." };
}

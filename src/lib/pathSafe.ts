import path from "node:path";

/** Raised when a requested path is missing, absolute, or outside the root. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolves a user/tool supplied path inside `root`, refusing anything that
 * escapes it. This is the only place tool paths are turned into real paths.
 */
export function resolveInRoot(root: string, candidate: string): string {
  if (typeof candidate !== "string") {
    throw new UnsafePathError("A file path is required.");
  }

  // Models routinely send "" to mean "the workspace root".
  const trimmed = candidate.trim();
  const effective = trimmed === "" ? "." : trimmed;

  if (path.isAbsolute(effective)) {
    throw new UnsafePathError(
      "Absolute paths are not allowed. Use a path relative to the workspace.",
    );
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, effective);
  const relative = path.relative(resolvedRoot, resolved);

  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new UnsafePathError("That path is outside the workspace.");
  }

  return resolved;
}

/** Path as the user should see it: relative to the workspace root. */
export function toWorkspacePath(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

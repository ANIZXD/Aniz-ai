export interface ToolOutcome {
  name: string;
  ok: boolean;
  verified: boolean;
  summary: string;
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
}

/**
 * M4: turns tool outcomes into evidence for the verifier. Anything not marked
 * `verified` is reported as attempted-but-unconfirmed.
 */
export function summarizeToolOutcomes(outcomes: ToolOutcome[]): string {
  if (outcomes.length === 0) return "No tools were used.";

  return outcomes
    .map((outcome) => {
      const status = outcome.ok
        ? outcome.verified
          ? "ok, verified"
          : "ok, unverified"
        : "failed";
      return `- ${outcome.name}: ${status} — ${firstLine(outcome.summary)}`;
    })
    .join("\n");
}

/** True when the run changed something on disk that was actually verified. */
export function hasVerifiedEffect(outcomes: ToolOutcome[]): boolean {
  return outcomes.some((outcome) => outcome.verified && outcome.ok);
}

/**
 * Deciding which browser Playwright should drive.
 *
 * Playwright normally downloads its own pinned Chromium, but that is a ~200 MiB
 * download that is not always possible (slow or blocked network, limited disk).
 * Every Windows and macOS machine already ships a Chromium-based browser — Edge
 * on Windows — and Playwright can drive one of those instead via a `channel`.
 *
 * This module is deliberately free of Playwright and of the filesystem: it
 * takes a `fileExists` probe and the environment, so the decision is testable.
 */

export type BrowserChannel = "msedge" | "chrome";

export interface BrowserChoice {
  /** `null` means the bundled Chromium Playwright downloaded itself. */
  channel: BrowserChannel | null;
  /** Human-readable description, used in availability messages. */
  label: string;
}

export interface LocateInput {
  /** Whether Playwright's own bundled Chromium is present. */
  bundled: boolean;
  platform: NodeJS.Platform;
  /** File probe, injected so tests need no real files. */
  fileExists: (candidate: string) => boolean;
  /** Environment to read install locations from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

interface Candidate {
  channel: BrowserChannel;
  label: string;
  /** Built per platform from the environment. */
  paths: (env: Record<string, string | undefined>) => string[];
}

function joinWindows(root: string | undefined, ...rest: string[]): string[] {
  if (root === undefined || root === "") return [];
  return [`${root.replace(/[\\/]+$/, "")}\\${rest.join("\\")}`];
}

/** Order matters: Edge first (present on every Windows box), then Chrome. */
const WINDOWS: Candidate[] = [
  {
    channel: "msedge",
    label: "Microsoft Edge",
    paths: (env) => [
      ...joinWindows(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
      ...joinWindows(env["ProgramFiles"], "Microsoft", "Edge", "Application", "msedge.exe"),
      ...joinWindows(env["LOCALAPPDATA"], "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
  },
  {
    channel: "chrome",
    label: "Google Chrome",
    paths: (env) => [
      ...joinWindows(env["ProgramFiles"], "Google", "Chrome", "Application", "chrome.exe"),
      ...joinWindows(env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
      ...joinWindows(env["LOCALAPPDATA"], "Google", "Chrome", "Application", "chrome.exe"),
    ],
  },
];

const MAC: Candidate[] = [
  {
    channel: "msedge",
    label: "Microsoft Edge",
    paths: () => ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  },
  {
    channel: "chrome",
    label: "Google Chrome",
    paths: () => ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  },
];

const LINUX: Candidate[] = [
  {
    channel: "msedge",
    label: "Microsoft Edge",
    paths: () => ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
  },
  {
    channel: "chrome",
    label: "Google Chrome",
    paths: () => ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  },
];

function candidatesFor(platform: NodeJS.Platform): Candidate[] {
  if (platform === "win32") return WINDOWS;
  if (platform === "darwin") return MAC;
  return LINUX;
}

/**
 * Picks the best available browser. The bundled Chromium wins when present
 * (it is the version Playwright was tested against); otherwise the first
 * installed system browser the platform knows about is used.
 */
export function pickBrowser(input: LocateInput): BrowserChoice | null {
  if (input.bundled) return { channel: null, label: "its bundled Chromium" };

  const env = input.env ?? (process.env as Record<string, string | undefined>);
  for (const candidate of candidatesFor(input.platform)) {
    for (const candidatePath of candidate.paths(env)) {
      if (input.fileExists(candidatePath)) {
        return { channel: candidate.channel, label: `the installed ${candidate.label}` };
      }
    }
  }

  return null;
}

import { existsSync } from "node:fs";
import { BadArgsError, optionalNumber, requireString } from "./args.ts";
import { pickBrowser, type BrowserChoice } from "./browserLocate.ts";
import type { Tool, ToolAvailability, ToolResult } from "./types.ts";

const MAX_PAGE_CHARS = 8_000;
const DEFAULT_PAGE_CHARS = 4_000;
/** Outbound traffic on this kind of machine is often slow; 20s was too tight. */
const NAVIGATION_TIMEOUT_MS = 30_000;

const PLAYWRIGHT_HINT =
  "Playwright is not installed, so browsing is unavailable. Enable it with: npm i playwright";

const BROWSER_HINT =
  "No browser could be found: Playwright's own Chromium is not downloaded and no system Microsoft Edge or Google Chrome was detected. Fix it with: npx playwright install chromium";

/** Injection point for tests: replaces the real browser with a stub. */
export interface BrowserDriver {
  fetchPage(url: string): Promise<{ title: string; text: string }>;
}

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
}

interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
    executablePath(): string;
  };
}

let cachedAvailability: ToolAvailability | null = null;

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    // The specifier is a variable so the type checker does not require the
    // optional dependency to be installed.
    const specifier = "playwright";
    return (await import(specifier)) as PlaywrightModule;
  } catch {
    return null;
  }
}

/**
 * The npm package and a browser binary are installed separately: importing
 * `playwright` succeeds even when Chromium was never downloaded, and only the
 * launch call fails. Resolve a real browser up front so availability tells the
 * truth, preferring Playwright's own Chromium and falling back to a system
 * Chromium (Edge/Chrome) that needs no download.
 */
function resolveBrowser(playwright: PlaywrightModule): BrowserChoice | null {
  let bundled = false;
  try {
    const executable = playwright.chromium.executablePath();
    bundled = executable.length > 0 && existsSync(executable);
  } catch {
    bundled = false;
  }

  return pickBrowser({
    bundled,
    platform: process.platform,
    fileExists: existsSync,
  });
}

/** Launch options for a resolved choice; a channel selects a system browser. */
function launchOptions(choice: BrowserChoice): Record<string, unknown> {
  return choice.channel === null
    ? { headless: true }
    : { headless: true, channel: choice.channel };
}

function truncate(text: string, limit: number): string {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}\n…(truncated)`;
}

/**
 * M6: read-only browser access.
 *
 * The tool navigates to a URL and returns the visible text. It never clicks,
 * types, or submits anything, so it cannot change state on a site. It is only
 * available when Playwright is actually installed; the tool reports that
 * honestly instead of pretending to work.
 */
export function createBrowserTools(driver?: BrowserDriver): Tool[] {
  const navigate: Tool = {
    name: "browser_navigate",
    description:
      "Open a web page and return its title and visible text. Read-only: it never clicks or submits.",
    risk: "read",
    parameters: {
      url: { type: "string", description: "http or https URL to open.", required: true },
      maxChars: {
        type: "number",
        description: `Maximum characters of page text to return (default ${DEFAULT_PAGE_CHARS}).`,
      },
    },

    async availability(): Promise<ToolAvailability> {
      if (driver) return { ok: true, detail: "A browser driver is attached." };
      if (cachedAvailability?.ok) return cachedAvailability;
      const playwright = await loadPlaywright();
      if (!playwright) return { ok: false, detail: PLAYWRIGHT_HINT };
      // Only a positive result is cached, so installing a browser mid-session
      // is picked up on the next check instead of staying unavailable forever.
      const choice = resolveBrowser(playwright);
      cachedAvailability = choice
        ? { ok: true, detail: `Playwright will drive ${choice.label}.` }
        : { ok: false, detail: BROWSER_HINT };
      return cachedAvailability;
    },

    async run(args): Promise<ToolResult> {
      let url: string;
      try {
        url = requireString(args, "url");
      } catch (error) {
        const message = error instanceof BadArgsError ? error.message : "A URL is required.";
        return { ok: false, summary: message };
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, summary: `"${url}" is not a valid URL.` };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, summary: "Only http and https URLs are supported." };
      }

      const maxChars = optionalNumber(args, "maxChars", DEFAULT_PAGE_CHARS, 200, MAX_PAGE_CHARS);

      try {
        if (driver) {
          const page = await driver.fetchPage(parsed.toString());
          return {
            ok: true,
            summary: `Title: ${page.title}\n\n${truncate(page.text, maxChars)}`,
          };
        }

        const playwright = await loadPlaywright();
        if (!playwright) return { ok: false, summary: PLAYWRIGHT_HINT };
        const choice = resolveBrowser(playwright);
        if (!choice) return { ok: false, summary: BROWSER_HINT };

        const browser = await playwright.chromium.launch(launchOptions(choice));
        try {
          const page = await browser.newPage();
          await page.goto(parsed.toString(), {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          });
          const title = await page.title();
          const text = await page.innerText("body");
          return {
            ok: true,
            summary: `Title: ${title}\n\n${truncate(text, maxChars)}`,
          };
        } finally {
          await browser.close();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "The page could not be opened.";
        // Playwright reports a bare timeout; say what it likely means instead.
        if (/Timeout \d+ms exceeded/.test(message)) {
          return {
            ok: false,
            summary: `The page did not finish loading within ${NAVIGATION_TIMEOUT_MS / 1000}s. The network may be slow, or the site may be refusing this browser.`,
          };
        }
        return { ok: false, summary: `Browsing failed: ${message}` };
      }
    },
  };

  return [navigate];
}

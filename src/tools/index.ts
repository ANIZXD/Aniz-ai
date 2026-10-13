import { createBrowserTools, type BrowserDriver } from "./browser.ts";
import { createFileTools } from "./files.ts";
import type { Tool } from "./types.ts";

export interface DefaultToolsOptions {
  browserDriver?: BrowserDriver;
}

export function createDefaultTools(options: DefaultToolsOptions = {}): Tool[] {
  return [...createFileTools(), ...createBrowserTools(options.browserDriver)];
}

export { createToolRegistry } from "./registry.ts";
export type { Tool, ToolContext, ToolResult, ToolRisk } from "./types.ts";

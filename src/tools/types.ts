export type ToolRisk = "read" | "write" | "destructive";

export interface ToolParameter {
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. Keep it short and factual. */
  summary: string;
  /**
   * Set by tools that check an observable outcome (M4). `true` means the effect
   * was confirmed after the fact, not merely attempted.
   */
  verified?: boolean;
}

export interface ToolContext {
  workspaceDir: string;
  allowWrite: boolean;
  allowDestructive: boolean;
  signal?: AbortSignal;
}

export interface ToolAvailability {
  ok: boolean;
  detail: string;
}

export interface Tool {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, ToolParameter>;
  availability(): Promise<ToolAvailability> | ToolAvailability;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

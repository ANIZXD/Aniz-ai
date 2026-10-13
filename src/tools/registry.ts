import type { Tool, ToolAvailability } from "./types.ts";

export interface ToolAvailabilityReport extends ToolAvailability {
  name: string;
  risk: Tool["risk"];
}

export interface ToolRegistry {
  list(): Tool[];
  get(name: string): Tool | undefined;
  /** Compact catalogue for the model's system prompt. */
  describe(): string;
  availability(): Promise<ToolAvailabilityReport[]>;
}

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    list: () => [...byName.values()],

    get: (name) => byName.get(name),

    describe(): string {
      return [...byName.values()]
        .map((tool) => {
          const params = Object.entries(tool.parameters)
            .map(([key, parameter]) => `${key}${parameter.required ? "" : "?"}: ${parameter.type}`)
            .join(", ");
          return `- ${tool.name}(${params}) [${tool.risk}] — ${tool.description}`;
        })
        .join("\n");
    },

    async availability(): Promise<ToolAvailabilityReport[]> {
      return Promise.all(
        [...byName.values()].map(async (tool) => {
          const status = await tool.availability();
          return { name: tool.name, risk: tool.risk, ...status };
        }),
      );
    },
  };
}

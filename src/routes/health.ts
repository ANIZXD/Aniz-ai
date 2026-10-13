import { Router } from "express";
import { APP_NAME, APP_VERSION, type AppConfig } from "../config.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";

export function createHealthRouter(
  config: AppConfig,
  getProvider: () => ProviderAdapter,
  getProviders: () => ProviderAdapter[],
  registry: ToolRegistry,
): Router {
  const router = Router();

  router.get("/", async (_request, response) => {
    const active = getProvider();

    const [checks, tools] = await Promise.all([
      Promise.all(
        getProviders().map(async (adapter) => {
          const availability = await adapter.isAvailable();
          return {
            id: adapter.id,
            label: adapter.label,
            kind: adapter.kind,
            active: adapter.id === active.id,
            model: adapter.defaultModel,
            ok: availability.ok,
            detail: availability.detail,
            models: availability.models ?? [],
          };
        }),
      ),
      registry.availability(),
    ]);

    const activeCheck = checks.find((check) => check.active);

    response.json({
      name: APP_NAME,
      version: APP_VERSION,
      ok: Boolean(activeCheck?.ok),
      provider: {
        id: active.id,
        label: active.label,
        kind: active.kind,
        model: active.defaultModel,
      },
      providers: checks,
      tools,
      workspace: { dir: config.workspaceDir },
      limits: { maxAgentSteps: config.maxAgentSteps },
    });
  });

  return router;
}

import path from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { BadRequestError, NotFoundError, toAppError } from "./errors.ts";
import { logger } from "./logger.ts";
import { listProviders, resolveProvider } from "./providers/index.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import { createChatRouter } from "./routes/chat.ts";
import { createHealthRouter } from "./routes/health.ts";
import { createSessionsRouter } from "./sessions/routes.ts";
import { createSessionStore, type SessionStore } from "./sessions/store.ts";
import { createDefaultTools, createToolRegistry } from "./tools/index.ts";
import type { BrowserDriver } from "./tools/browser.ts";
import type { ToolRegistry } from "./tools/registry.ts";
import type { AppConfig } from "./config.ts";

export interface AppOptions {
  /** Replace the active provider (used by tests). */
  provider?: ProviderAdapter;
  /** Replace the providers listed by /api/health (used by tests). */
  providers?: ProviderAdapter[];
  /** Replace the session store (used by tests). */
  store?: SessionStore;
  /** Replace the tool registry (used by tests). */
  registry?: ToolRegistry;
  /** Replace the browser driver (used by tests). */
  browserDriver?: BrowserDriver;
}

export function createApp(config: AppConfig, options: AppOptions = {}): express.Express {
  const provider = options.provider ?? resolveProvider(config);
  const providers = options.providers ?? listProviders(config);
  const store = options.store ?? createSessionStore(config.sessionsFile);
  const registry =
    options.registry ??
    createToolRegistry(createDefaultTools({ browserDriver: options.browserDriver }));

  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "256kb" }));

  app.use("/api/health", createHealthRouter(config, () => provider, () => providers, registry));
  app.use("/api/sessions", createSessionsRouter(store));
  app.use(
    "/api/chat",
    createChatRouter({
      getProvider: () => provider,
      registry,
      store,
      workspaceDir: config.workspaceDir,
      maxAgentSteps: config.maxAgentSteps,
      chatHistory: config.chatHistory,
    }),
  );
  app.use("/api", (_request, _response, next) => next(new NotFoundError()));

  const webRoot = path.join(import.meta.dirname, "..", "web");
  app.use(express.static(webRoot, { index: "index.html" }));

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      const appError =
        error instanceof SyntaxError
          ? new BadRequestError("The request body was not valid JSON.")
          : toAppError(error);

      if (appError.status >= 500) {
        logger.error("Unhandled request error", {
          code: appError.code,
          message: appError.message,
        });
      }

      if (response.headersSent) {
        response.end();
        return;
      }
      response.status(appError.status).json(appError.toJSON());
    },
  );

  return app;
}

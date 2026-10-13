import { mkdir } from "node:fs/promises";
import { createApp } from "./app.ts";
import { APP_NAME, APP_VERSION, describeConfig, loadConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { resolveProvider } from "./providers/index.ts";
import { createDefaultTools, createToolRegistry } from "./tools/index.ts";

const config = loadConfig();

await Promise.all([
  mkdir(config.dataDir, { recursive: true }),
  mkdir(config.workspaceDir, { recursive: true }),
]);

const app = createApp(config);

const server = app.listen(config.port, config.host, async () => {
  logger.info(`${APP_NAME} v${APP_VERSION} listening on http://${config.host}:${config.port}`);
  logger.info("Configuration", describeConfig(config));

  const availability = await resolveProvider(config)
    .isAvailable()
    .catch(() => ({ ok: false, detail: "Could not determine provider availability.", models: [] }));

  const write = availability.ok ? logger.info : logger.warn;
  write(`Provider "${config.provider}": ${availability.detail}`);

  const tools = await createToolRegistry(createDefaultTools()).availability();
  const ready = tools.filter((tool) => tool.ok).map((tool) => tool.name);
  const missing = tools.filter((tool) => !tool.ok).map((tool) => tool.name);
  logger.info(`Tools ready: ${ready.join(", ")}`);
  if (missing.length > 0) logger.warn(`Tools unavailable: ${missing.join(", ")}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    logger.error(`Port ${config.port} is already in use. Set a different PORT in .env.`);
  } else {
    logger.error("The server failed to start.", { code: error.code });
  }
  process.exit(1);
});

function shutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down.`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

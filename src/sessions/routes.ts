import { Router } from "express";
import { BadRequestError, NotFoundError } from "../errors.ts";
import type { SessionStore } from "./store.ts";

const MAX_TITLE_CHARS = 120;

function readTitle(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    throw new BadRequestError("Send a JSON body with a 'title' field.");
  }
  const { title } = body as Record<string, unknown>;
  if (typeof title !== "string" || title.trim() === "") {
    throw new BadRequestError("A session title cannot be empty.");
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new BadRequestError(`That title is too long (max ${MAX_TITLE_CHARS} characters).`);
  }
  return title.trim();
}

export function createSessionsRouter(store: SessionStore): Router {
  const router = Router();

  router.get("/", async (_request, response) => {
    response.json({ sessions: await store.list() });
  });

  router.post("/", async (request, response) => {
    let title = "";
    const body = request.body as Record<string, unknown> | undefined;
    if (body && body.title !== undefined) title = readTitle(body);
    response.status(201).json({ session: await store.create(title) });
  });

  router.get("/:id", async (request, response) => {
    const session = await store.get(request.params.id);
    if (!session) throw new NotFoundError("That conversation does not exist.");
    response.json({ session });
  });

  router.patch("/:id", async (request, response) => {
    const title = readTitle(request.body);
    const session = await store.rename(request.params.id, title);
    if (!session) throw new NotFoundError("That conversation does not exist.");
    response.json({ session });
  });

  router.delete("/:id", async (request, response) => {
    const removed = await store.remove(request.params.id);
    if (!removed) throw new NotFoundError("That conversation does not exist.");
    response.status(204).end();
  });

  return router;
}

import type { Response } from "express";

export function startEventStream(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function sendEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE comment line. Used as a heartbeat so idle streams are not cut off. */
export function sendComment(res: Response, text: string): void {
  if (res.writableEnded) return;
  res.write(`: ${text}\n\n`);
}

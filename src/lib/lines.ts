/**
 * Structural stream types. Kept minimal so they accept any real byte stream
 * (Node's `fetch` body, `node:stream/web`, a test double) without imports.
 */
export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
}

export interface ReadableByteStream {
  getReader(): ByteStreamReader;
}

/**
 * Yields newline-delimited lines from a byte stream as they arrive, without
 * waiting for the whole body. Handles CRLF and a final line with no newline.
 */
export async function* readLines(body: ReadableByteStream): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf("\n");
      while (index !== -1) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, "");
    if (tail.trim() !== "") yield tail;
  } finally {
    reader.releaseLock();
  }
}

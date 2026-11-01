/**
 * A hub's `/api/events` for tests: each request opens a connection the test writes frames to,
 * starting with `opening` when given.
 */
export const fakeEventStream = (opening?: string) => {
  const encoder = new TextEncoder();
  const connections: Array<{ write: (text: string) => void; close: () => void; aborted: boolean }> = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
        if (opening) c.enqueue(encoder.encode(opening));
      },
    });
    const connection = {
      aborted: false,
      write: (text: string) => controller?.enqueue(encoder.encode(text)),
      close: () => controller?.close(),
    };
    init?.signal?.addEventListener("abort", () => {
      connection.aborted = true;
      try {
        controller?.error(new Error("aborted"));
      } catch {
        // Already closed.
      }
    });
    connections.push(connection);
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  const last = () => {
    const connection = connections.at(-1);
    if (!connection) throw new Error("No connection yet");
    return connection;
  };
  return { fetch, connections, last };
};

/** The first frame of every connection, as the hub writes it. */
export const readyFrame = 'retry: 1000\n\nid: e.0\nevent: ready\ndata: {"cursor":"e.0","resumed":false}\n\n';

/** A journal entry frame, with only what the main process reads. */
export const entryFrame = (type: string, payload: unknown, sequence = 1) =>
  `id: e.${sequence}\ndata: ${JSON.stringify({ sequence, type, payload })}\n\n`;

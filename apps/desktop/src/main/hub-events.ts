/**
 * Follows the hub's event stream from the main process, so the menu-bar icon and the request
 * notifications learn of changes as they happen, with every window closed, and an idle app sends
 * no requests. Electron stays out of this file; index.ts passes the hub in.
 */
import { frameChange, type HubChange, parseSse } from "./hub-events-model.ts";

export interface HubEventsOptions {
  /** The hub's `/api/events` URL. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Whether the hub may answer now; while it may not, the stream waits for `wake`. */
  readonly canConnect: () => boolean;
  /** The stream connected: anything may have changed since the last connection. */
  readonly onConnected: () => void;
  readonly onChange: (change: HubChange) => void;
  /** A connected stream ended: the hub stopped, stopped answering, or dropped this connection. */
  readonly onLost: () => void;
  readonly fetch?: typeof fetch;
  /** The wait before connecting again, doubling after each failed try up to `maxRetryMs`. */
  readonly firstRetryMs?: number;
  readonly maxRetryMs?: number;
  /** How long the stream may stay silent before it counts as lost. */
  readonly silenceMs?: number;
}

/** The hub sends a keep-alive every 15 seconds; three missed ones mean it stopped answering. */
const SILENCE_MS = 45_000;

/** Connects at once and again after each loss. Answers `wake`, to connect now, and `stop`. */
export const followHub = (options: HubEventsOptions) => {
  const { url, headers = {}, canConnect, onConnected, onChange, onLost } = options;
  const request = options.fetch ?? fetch;
  const firstRetryMs = options.firstRetryMs ?? 1_000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  const silenceMs = options.silenceMs ?? SILENCE_MS;
  let stopped = false;
  let retryMs = firstRetryMs;
  let connection: AbortController | null = null;
  let wakeUp: (() => void) | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakeUp = null;
        resolve();
      }
      wakeUp = done;
    });

  /** Reads one connection until it ends; answers whether it connected. */
  const connect = async () => {
    const abort = new AbortController();
    connection = abort;
    let silence: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(silence);
      silence = setTimeout(() => abort.abort(), silenceMs);
    };
    let connected = false;
    try {
      heard();
      const response = await request(url, {
        headers: { accept: "text/event-stream", ...headers },
        signal: abort.signal,
      });
      if (!response.ok || !response.body) return false;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        heard();
        const parsed = parseSse(rest + value);
        rest = parsed.rest;
        for (const frame of parsed.frames) {
          const change = frameChange(frame);
          if (change === "connected") {
            connected = true;
            retryMs = firstRetryMs;
            onConnected();
          } else if (change !== null) {
            onChange(change);
          }
        }
      }
    } catch {
      // A refused, aborted or broken connection ends like a closed one.
    } finally {
      clearTimeout(silence);
      connection = null;
    }
    return connected;
  };

  const run = async () => {
    while (!stopped) {
      if (!canConnect()) {
        await wait(maxRetryMs);
        continue;
      }
      const connected = await connect();
      if (stopped) return;
      if (connected) onLost();
      await wait(retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
    }
  };
  const running = run();

  return {
    /** Connects now instead of after the current wait, for a hub that just started. */
    wake: () => {
      retryMs = firstRetryMs;
      wakeUp?.();
    },
    /** Closes the stream for good; resolves once it closed. */
    stop: () => {
      stopped = true;
      connection?.abort();
      wakeUp?.();
      return running;
    },
  };
};

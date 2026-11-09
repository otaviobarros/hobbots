import { messages } from "./messages.ts";
import { WebIcon } from "./reply-web.tsx";
import type { WebAsk } from "./web-ask.ts";

const copy = messages.ask;

/**
 * Below a web approval's address (ADR 036): why a page like it asks, and the banner when it asks
 * because the chat read the web.
 */
export function WebAskNotes({ ask, name }: { ask: WebAsk; name: string }) {
  return (
    <>
      {ask.why !== null && <p className="m-0 text-detail text-text-secondary">{ask.why}</p>}
      {ask.marked && (
        <div className="flex items-start gap-2 rounded-control bg-lantern/12 px-2.5 py-2 text-detail text-text">
          <span className="mt-0.5 shrink-0 text-lantern">
            <WebIcon kind="globe" />
          </span>
          <span>
            <b className="font-semibold text-text-strong">{copy.readWeb.title}</b> {copy.readWeb.body({ name })}
          </span>
        </div>
      )}
    </>
  );
}

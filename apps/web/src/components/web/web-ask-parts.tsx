import { type ApprovalRequest, exactAction } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { type WebAsk, webAskOf } from "./web-ask.ts";
import { WebIcon } from "./web-icon.tsx";

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

/**
 * What a request in the Needs-you tray asks to do: why, then the command after a `$`. A web ask
 * shows the page's address instead, then why a page like it asks (ADR 036).
 */
export function TrayAction({ request, name }: { request: ApprovalRequest; name: string }) {
  const web = webAskOf(request, name);
  const page = web?.kind != null && web.url !== null ? web.url : null;
  return (
    <>
      {page === null && <p className="m-0 text-text">{request.reason}</p>}
      <div className="flex gap-2 rounded-tag bg-deep px-3 py-2 font-mono text-code">
        {page === null && (
          <span aria-hidden className="text-label">
            $
          </span>
        )}
        <code className="break-all whitespace-pre-wrap text-text-strong">{page ?? exactAction(request)}</code>
      </div>
      {web !== null && <WebAskNotes ask={web} name={name} />}
    </>
  );
}

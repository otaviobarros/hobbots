import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inboxQuery } from "../../api/approvals.ts";
import { HobSprite } from "../hob-sprite.tsx";
import { requestTitle, statusText, tabRequests } from "./inbox-items.ts";
import { messages } from "./messages.ts";
import { useInboxDirectory } from "./use-inbox-directory.ts";
import { useNow } from "./use-now.ts";

const copy = messages;

/** How many waiting requests Home lists before it points to the Inbox. */
const SHOWN = 3;

/**
 * The requests that wait for the user, for Home's Needs you card: the first few, oldest first, each
 * opening in the Inbox, and how many more wait there. Renders `empty` when nothing waits.
 */
export function WaitingRequests({ empty }: { empty: React.ReactNode }) {
  const inbox = useQuery(inboxQuery);
  const waiting = tabRequests(inbox.data ?? [], "needs");
  const directory = useInboxDirectory(waiting);
  const now = useNow();
  if (waiting.length === 0) return empty;
  const more = waiting.length - SHOWN;
  return (
    <ul aria-label={copy.waiting({ count: waiting.length })} className="m-0 flex list-none flex-col gap-1 p-0">
      {waiting.slice(0, SHOWN).map((request) => {
        const hob = directory.hob(request.agentId);
        const title = requestTitle(request);
        return (
          <li key={request.id} className="border-t-2 border-line pt-2">
            <Link
              to="/inbox"
              search={{ tab: "needs", request: request.id }}
              className="hop-on-hover flex items-start gap-2.5 text-text no-underline hover:text-moonlight"
            >
              {hob && <HobSprite hob={hob} size={26} state="needs-you" className="mt-0.5" />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-secondary-text">
                  {copy.from({ name: directory.hobName(request.agentId) })}
                </span>
                <span className="text-sm leading-snug">{title.what}</span>
                <code className="truncate font-mono text-xs text-moonlight">{title.exact}</code>
                <span className="text-xs text-lantern">{statusText(request, now)}</span>
              </span>
            </Link>
          </li>
        );
      })}
      <li className="border-t-2 border-line pt-2">
        <Link to="/inbox" search={{ tab: "needs" }} className="text-sm">
          {more > 0 ? copy.home.more({ count: more }) : copy.home.open}
        </Link>
      </li>
    </ul>
  );
}

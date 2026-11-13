import { Button } from "@hobbots/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@hobbots/ui/components/empty";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Link, useNavigate } from "@tanstack/react-router";
import type { InboxIn, InboxScope } from "./inbox-scope.ts";
import { messages } from "./messages.ts";

const copy = messages.scope;

/**
 * Above Needs you's list when the Inbox opened on a chat or camp (#1423): that place, or Everywhere.
 * A pick goes into the address, so a link or Back opens the same list.
 */
export function InboxScopePicker({ scope, place }: { scope: InboxIn; place: string }) {
  const navigate = useNavigate();
  const pick = (next: InboxScope) =>
    void navigate({
      to: "/inbox",
      search: { tab: "needs", in: scope.threadId, ...(next === "everywhere" && { scope: next }) },
      replace: true,
    });
  return (
    <div className="flex items-center gap-2 px-4 pt-2.5">
      <span className="flex-1 text-meta text-label">{copy.label}</span>
      <SegmentedControl size="sm" aria-label={copy.label} value={scope.scope} onValueChange={pick}>
        <SegmentedControlItem value="here" className="max-w-40">
          <span className="truncate">{place}</span>
        </SegmentedControlItem>
        <SegmentedControlItem value="everywhere">{copy.everywhere}</SegmentedControlItem>
      </SegmentedControl>
    </div>
  );
}

/** Needs you on a chat or camp where nothing waits, while something waits elsewhere: the way there. */
export function QuietHere({ scope, place }: { scope: InboxIn; place: string }) {
  return (
    <Empty size="page">
      <EmptyHeader>
        <EmptyTitle>{copy.quietTitle({ place })}</EmptyTitle>
        <EmptyDescription>{copy.quietHint}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/inbox" search={{ tab: "needs", in: scope.threadId, scope: "everywhere" }}>
            {copy.seeEverywhere}
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}

import { Button } from "@hobbots/ui/components/button";
import { HubWait } from "../loading/hub-wait.tsx";
import { messages } from "./messages.ts";

/** How the thread's Tasks read while the quest is not found among them. */
export type TasksRead = { isPending: boolean; isError: boolean; refetch: () => unknown };

/**
 * What stands in for a quest the thread's Tasks do not hold yet: the hub's wait while they load, an
 * alert with Try again when they could not be read, and else that the quest is not there.
 */
export function QuestRead({ read, missing }: { read: TasksRead; missing: boolean }) {
  if (read.isPending) return <HubWait pending onRetry={() => void read.refetch()} />;
  if (read.isError) {
    return (
      <p role="alert" className="m-0 flex items-center gap-2 text-detail text-rose">
        {messages.readFailed}
        <Button variant="ghost" size="xs" onClick={() => void read.refetch()}>
          {messages.tryAgain}
        </Button>
      </p>
    );
  }
  return missing ? <p className="m-0 text-detail text-label">{messages.notFound}</p> : null;
}

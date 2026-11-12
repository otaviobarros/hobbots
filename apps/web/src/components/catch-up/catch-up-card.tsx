import type { Agent, CatchUp, CatchUpItem, MessageId } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { formatTime } from "../../lib/time.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "./messages.ts";

/** How many updates a catch-up holds: the replies, and every change, listed or counted. */
const updatesOf = (catchUp: CatchUp): number => catchUp.replies + catchUp.items.length + catchUp.more;

/** One row of the card: its tag, its words and the message to jump to. */
interface Row {
  readonly key: string;
  readonly tag: string;
  readonly needs: boolean;
  readonly text: string;
  readonly messageId: MessageId | null;
}

const rowOf = (item: CatchUpItem): Row => {
  switch (item._tag) {
    case "NeedsYou":
      return {
        key: `needs-${item.questId}`,
        tag: messages.tag.needsYou,
        needs: true,
        text: messages.needsYou({ goal: item.goal, count: item.count }),
        messageId: item.messageId,
      };
    case "QuestEnded":
      return {
        key: `ended-${item.questId}`,
        tag: messages.tag.ended,
        needs: false,
        text: messages.ended[item.state]({ goal: item.goal }),
        messageId: item.messageId,
      };
    case "Decided":
      return {
        key: `decided-${item.decision.id}`,
        tag: messages.tag.decided,
        needs: false,
        text: item.decision.text,
        messageId: item.messageId,
      };
    case "CrossedOut":
      return {
        key: `crossed-${item.decision.id}`,
        tag: messages.tag.changed,
        needs: false,
        text: messages.crossedOut({ text: item.decision.text }),
        messageId: item.messageId,
      };
    case "Made":
      return {
        key: `made-${item.artifact.id}`,
        tag: messages.tag.made,
        needs: false,
        text: messages.made({ title: item.artifact.title, version: item.artifact.latestVersion }),
        messageId: item.messageId,
      };
  }
};

/** The rows the card lists: the replies that landed first, then each change. */
const rowsOf = (catchUp: CatchUp): ReadonlyArray<Row> => [
  ...(catchUp.replies > 0
    ? [
        {
          key: "replies",
          tag: messages.tag.replies,
          needs: false,
          text: messages.replies({ count: catchUp.replies }),
          messageId: catchUp.firstUnread,
        },
      ]
    : []),
  ...catchUp.items.map(rowOf),
];

/** Where what you have not read starts, with when you last read: a lantern line. */
function NewSinceLine({ catchUp }: { catchUp: CatchUp }) {
  const text = messages.newSince({ time: catchUp.readUpTo === null ? null : formatTime(catchUp.readUpTo) });
  return (
    <p className="m-0 flex items-center gap-3 text-meta font-semibold text-lantern">
      <span aria-hidden className="h-px flex-1 bg-lantern" />
      <span>{text}</span>
      <span aria-hidden className="h-px flex-1 bg-lantern" />
    </p>
  );
}

/**
 * While you were away (ADR 037): what changed in the chat since you last read it, as the hub worked
 * it out, what waits on you first. Each row jumps to the message it happened at; Got it folds it.
 */
function CatchUpCard({
  hob,
  catchUp,
  onJump,
  onFold,
}: {
  hob: Agent;
  catchUp: CatchUp;
  onJump: (messageId: MessageId) => void;
  onFold: () => void;
}) {
  return (
    <section
      aria-label={messages.heading}
      className="flex animate-hb-in flex-col gap-2.5 rounded-card bg-card p-4 border-(length:--edge) border-line"
    >
      <header className="flex items-center gap-2.5">
        <HobTile hob={hob} tile="md" />
        <span className="flex min-w-0 flex-col">
          <h3 className="m-0 text-ui font-semibold text-text-strong">{messages.heading}</h3>
          <span className="text-meta text-label">{messages.byline({ name: hob.name, count: updatesOf(catchUp) })}</span>
        </span>
      </header>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {rowsOf(catchUp).map((row) => (
          <li key={row.key} className="flex items-center gap-2.5 py-1">
            <Badge variant={row.needs ? "needs-you" : "resting"}>{row.tag}</Badge>
            <span className="min-w-0 flex-1 text-ui text-text-strong">{row.text}</span>
            {row.messageId !== null && (
              <Button
                variant="text"
                size="xs"
                aria-label={messages.jumpTo({ text: row.text })}
                onClick={() => row.messageId && onJump(row.messageId)}
              >
                {messages.jump}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {catchUp.more > 0 && <span className="text-meta text-label">{messages.more({ count: catchUp.more })}</span>}
      <Button variant="outline" size="sm" className="self-start" onClick={onFold}>
        {messages.fold}
      </Button>
    </section>
  );
}

/** Where a folded catch-up was: one line that says how much it held. */
function CaughtUpLine({ catchUp }: { catchUp: CatchUp }) {
  const text = messages.caughtUp({ count: updatesOf(catchUp) });
  return (
    <p className="m-0 flex items-center gap-3 text-meta text-label">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span>{text}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </p>
  );
}

/** What the transcript shows of catching up, where what you have not read starts. */
export function CatchUpAt({
  hob,
  view,
  onJump,
}: {
  hob: Agent;
  view: { readonly open: CatchUp | null; readonly folded: CatchUp | null; readonly fold: () => void };
  onJump: (messageId: MessageId) => void;
}) {
  if (view.folded !== null) return <CaughtUpLine catchUp={view.folded} />;
  if (view.open === null) return null;
  return (
    <>
      <NewSinceLine catchUp={view.open} />
      <CatchUpCard hob={hob} catchUp={view.open} onJump={onJump} onFold={view.fold} />
    </>
  );
}

import { type Chapter, ChapterStates, type TaskTree, type Thread } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { chaptersQuery } from "../../api/chapters.ts";
import { briefQuery } from "../../api/records.ts";
import { useSetCampPrivate } from "../../api/thread-settings.ts";
import { AlongRow } from "../camps/camp-parts.tsx";
import { StatusStrip } from "../quest/status-strip.tsx";
import { useQuestProgress } from "../quest/use-quest-progress.ts";
import { useThreadTrees } from "../quest/use-work.ts";
import { taskTitle, workCard } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { ReadState, SheetSection } from "./sheet-parts.tsx";

const copy = messages.overview;

/**
 * The Overview tab (ADR 037): "Where we are", the brief the hub writes from the records; the Quests
 * started here; the camp's chapters; and its settings, where a camp is made private from now on.
 */
export function OverviewTab({ thread, hobName }: { thread: Thread; hobName: string }) {
  const brief = useQuery(briefQuery(thread.id));
  const chapters = useQuery(chaptersQuery(thread.id));
  const trees = useThreadTrees(thread.id);
  const text = brief.data?.text ?? "";
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label={copy.whereWeAre}
        className="flex flex-col gap-1.5 rounded-control bg-card p-3 border-(length:--edge) border-line"
      >
        <h3 className="lbl m-0 text-meta font-normal text-label">{copy.whereWeAre}</h3>
        <ReadState read={brief} empty={brief.isSuccess && text === "" ? copy.noBrief({ name: hobName }) : undefined} />
        {text !== "" && <p className="m-0 text-ui whitespace-pre-wrap text-text-strong">{text}</p>}
        <span className="text-meta text-label">{copy.briefNote({ name: hobName })}</span>
      </section>
      <SheetSection title={copy.quests}>
        {trees.length === 0 && <p className="m-0 text-ui text-label">{copy.noQuests}</p>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {trees.map((tree) => (
            <QuestRow key={tree.tasks[0]?.id} tree={tree} />
          ))}
        </ul>
      </SheetSection>
      <SheetSection title={copy.chapters}>
        <ReadState read={chapters} empty={undefined} />
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {(chapters.data ?? []).filter((chapter) => chapter.state !== "moved").map(ChapterRow)}
        </ul>
      </SheetSection>
      <PrivateSetting thread={thread} hobName={hobName} />
    </div>
  );
}

function QuestRow({ tree }: { tree: TaskTree }) {
  const card = workCard(tree);
  // How the Quest is going is the hub's, from its summary (#1429).
  const { segments, needs, done, total } = useQuestProgress(tree);
  if (card === null) return null;
  return (
    <li className="flex flex-col gap-1.5 rounded-control px-2 py-2">
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui font-semibold text-text-strong">
          {card.quest?.goal ?? taskTitle(card.top)}
        </span>
        {needs > 0 && <Badge variant="needs-you">{copy.needsYou({ count: needs })}</Badge>}
        <span className="shrink-0 text-meta text-label">
          {card.quest !== null && card.quest.state !== "active"
            ? copy.questState[card.quest.state]
            : copy.done({ done, total })}
        </span>
      </span>
      <StatusStrip statuses={segments} />
    </li>
  );
}

function ChapterRow(chapter: Chapter) {
  return (
    <li key={chapter.id} className="flex items-center gap-2 rounded-control px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-ui text-text-strong">
        {chapter.title ?? copy.untitled({ number: chapter.number })}
      </span>
      <span className="text-meta text-label">{ChapterStates.isLive(chapter) ? copy.live : copy.resting}</span>
    </li>
  );
}

/** The camp's privacy, changed from now on (ADR 037, #1377): what memory captured before stays. */
function PrivateSetting({ thread, hobName }: { thread: Thread; hobName: string }) {
  const change = useSetCampPrivate();
  return (
    <SheetSection title={copy.settings}>
      <AlongRow
        title={copy.private}
        detail={thread.private ? copy.privateOn({ name: hobName }) : copy.privateOff({ name: hobName })}
        checked={thread.private}
        onChange={change.isPending ? undefined : (value) => change.mutate({ thread, value })}
      />
      {change.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.privateFailed}
        </p>
      )}
    </SheetSection>
  );
}

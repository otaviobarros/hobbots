import { type Attempt, type AttemptId, isLiveAttempt, policySandbox, type Task, type TaskTree } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { OverflowTooltip } from "@hobbots/ui/components/overflow-tooltip";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { agentsQuery, runtimesQuery } from "../../api/queries.ts";
import { formatCount } from "../../lib/format.ts";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import { useBrainLabel } from "../providers/brain-picker.tsx";
import { folderName, memberFolders } from "../quest/member-folders.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { type ActivityRead, askedBy } from "./workbench-model.ts";

type Sandbox = "on" | "off" | "unavailable";

/**
 * Where the Task runs on the hub: outside the sandbox once any of its commands ran there, else as
 * the runtime's sandbox stands on this hub (ADR 014). `checking` while the runtimes are read, and
 * null when the hub does not list the runtime.
 */
const useSandbox = (runtime: Attempt["runtime"], read: ActivityRead): Sandbox | "checking" | null => {
  const health = useQuery({ ...runtimesQuery, select: (all) => all.find((each) => each.runtime === runtime) });
  if (typeof read === "object" && read.commands.some((command) => !command.sandboxed)) return "off";
  if (health.isPending) return "checking";
  return health.data === undefined ? null : policySandbox(health.data.enforcement);
};

/**
 * The Workbench header (ADR 023), one compact row over the panels: the owner's tile, the Task's
 * title, cut to a line with the whole of it on hover, with who owns it, who asked, the brain it thinks with, where it runs and whether its session read the web, then an Attempt switcher once it was
 * retried, one Live or History tag for the Attempt shown.
 */
export function WorkbenchHeader({
  tree,
  task,
  attempts,
  attempt,
  read,
  hobs,
  headingRef,
  onAttempt,
}: {
  tree: TaskTree;
  task: Task;
  attempts: ReadonlyArray<Attempt>;
  attempt: Attempt | null;
  read: ActivityRead;
  hobs: HobLookup;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onAttempt: (attemptId: AttemptId) => void;
}) {
  const owner = hobs(task.ownerId);
  const running = attempt !== null && isLiveAttempt(attempt.state);
  return (
    <header className="flex items-center gap-x-2.5 px-4 pb-2">
      <HobTile hob={owner} tile="md" state={running ? "working" : "idle"} />
      <span className="flex min-w-0 flex-1 flex-col">
        <OverflowTooltip text={taskTitle(task)}>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="m-0 min-w-0 truncate text-ui font-semibold text-text-strong outline-none"
          >
            {taskTitle(task)}
          </h2>
        </OverflowTooltip>
        <Byline tree={tree} task={task} attempt={attempt} read={read} hobs={hobs} />
      </span>
      {attempts.length > 1 && attempt !== null && (
        <AttemptPicker attempts={attempts} chosen={attempt.id} onAttempt={onAttempt} />
      )}
      {attempt !== null && <AttemptTag running={running} />}
    </header>
  );
}

/** "<owner> · asked by You → <lead> · <brain> · in the sandbox · Read the web · Works in <folders>". */
function Byline({
  tree,
  task,
  attempt,
  read,
  hobs,
}: {
  tree: TaskTree;
  task: Task;
  attempt: Attempt | null;
  read: ActivityRead;
  hobs: HobLookup;
}) {
  const chain = [messages.you, ...askedBy(tree, task).map((id) => hobs(id).name)];
  const agent = useQuery({ ...agentsQuery, select: (all) => all.find((each) => each.id === task.ownerId) }).data;
  // An Attempt records its runtime; before the first, the owner's is the one it will think with.
  const runtime = attempt?.runtime ?? agent?.runtime ?? null;
  // The model is the owner's while it thinks with that runtime.
  const model = agent?.runtime === runtime ? (agent?.model ?? null) : null;
  return (
    <span className="flex min-w-0 items-center gap-x-1 overflow-hidden text-meta whitespace-nowrap text-label">
      <span>{hobs(task.ownerId).name}</span>
      <Dot />
      <span>{messages.askedBy({ chain })}</span>
      {runtime !== null && <Brain runtime={runtime} model={model} />}
      {runtime !== null && <Where runtime={runtime} read={read} />}
      <ReadWeb attempt={attempt} />
      <Folders folders={memberFolders(tree, task)} />
    </span>
  );
}

function Dot() {
  return <span aria-hidden>·</span>;
}

/** Live while the Attempt shown runs, History once it does not: the one label every tab follows. */
function AttemptTag({ running }: { running: boolean }) {
  return running ? (
    <Badge variant="working">
      <span aria-hidden data-slot="badge-glyph">
        ●
      </span>
      {messages.state.live}
    </Badge>
  ) : (
    <Badge variant="resting">{messages.state.history}</Badge>
  );
}

/** The folders a member works in, by name, each full path in the hint. Nothing for work no lead gave. */
function Folders({ folders }: { folders: ReadonlyArray<string> | null }) {
  if (folders === null) return null;
  return (
    <>
      <Dot />
      <span title={folders.join("\n")} className="min-w-0 truncate">
        {folders.length === 0 ? messages.noFolders : messages.worksIn({ names: folders.map(folderName) })}
      </span>
    </>
  );
}

/** The runtime and model the Task thinks with. */
function Brain({ runtime, model }: { runtime: Attempt["runtime"]; model: string | null }) {
  const label = useBrainLabel({ runtime, model });
  return (
    <>
      <Dot />
      <span>{label}</span>
    </>
  );
}

const sandboxWords: Record<Sandbox, string> = {
  on: messages.inSandbox,
  off: messages.unsandboxed,
  unavailable: messages.sandboxNotReady,
};

/** In the sandbox, or the Unsandboxed tag, with a tag block in its place while the runtimes are read. */
function Where({ runtime, read }: { runtime: Attempt["runtime"]; read: ActivityRead }) {
  const sandbox = useSandbox(runtime, read);
  if (sandbox === null) return null;
  if (sandbox === "checking") {
    return (
      <>
        <Dot />
        <Skeleton shape="block" width="12ch" />
      </>
    );
  }
  return (
    <>
      <Dot />
      <span
        title={messages.sandboxHint[sandbox]}
        className={cn(
          sandbox === "off" && "rounded-tag border border-rose px-1.5 text-meta font-bold text-rose",
          sandbox === "unavailable" && "rounded-tag bg-line-2 px-1.5 text-meta font-bold text-text-secondary",
        )}
      >
        {sandbox === "on" ? messages.inSandboxLower : sandboxWords[sandbox]}
      </span>
    </>
  );
}

/**
 * The Read the web tag, once the Attempt's session searched or read a page (ADR 036): until it ends,
 * what could send data out asks. The hint names what it read last.
 */
function ReadWeb({ attempt }: { attempt: Attempt | null }) {
  const mark = attempt?.readWeb;
  if (mark == null) return null;
  return (
    <>
      <Dot />
      <span
        title={messages.readWebHint({ source: mark.source })}
        className="rounded-tag bg-lantern/15 px-1.5 text-meta font-bold text-text-strong"
      >
        {messages.readWeb}
      </span>
    </>
  );
}

/** "Attempt 1 2 3", compact: every tab follows the chosen one. */
function AttemptPicker({
  attempts,
  chosen,
  onAttempt,
}: {
  attempts: ReadonlyArray<Attempt>;
  chosen: AttemptId;
  onAttempt: (attemptId: AttemptId) => void;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="text-detail text-label">
        {messages.attemptWord}
      </span>
      <SegmentedControl size="sm" aria-label={messages.attempts} value={chosen} onValueChange={onAttempt}>
        {attempts.map((each) => (
          <SegmentedControlItem
            key={each.id}
            value={each.id}
            aria-label={messages.attempt({ number: each.number })}
            className="min-w-hit-min px-2"
          >
            {formatCount(each.number)}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </span>
  );
}

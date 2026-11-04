import { HOB_COLORS } from "@hobbots/art/look";
import { type Attempt, type AttemptId, isLiveAttempt, policySandbox, type Task, type TaskTree } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { agentsQuery, runtimesQuery } from "../../api/queries.ts";
import { formatCount } from "../../lib/format.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { useBrainLabel } from "../providers/brain-picker.tsx";
import { folderName, memberFolders } from "../quest/member-folders.ts";
import type { HobLookup } from "../quest/use-work.ts";
import { taskTitle } from "../quest/work-model.ts";
import { messages } from "./messages.ts";
import { type ActivityRead, askedBy } from "./workbench-model.ts";

type Sandbox = "on" | "off" | "unavailable";

/**
 * Where the Task runs on the hub: outside the sandbox once any of its commands ran there, else as
 * the runtime's sandbox stands on this hub (ADR 014). Unknown until the runtimes are read.
 */
const useSandbox = (runtime: Attempt["runtime"], read: ActivityRead): Sandbox | null => {
  const health = useQuery({ ...runtimesQuery, select: (all) => all.find((each) => each.runtime === runtime) });
  if (typeof read === "object" && read.commands.some((command) => !command.sandboxed)) return "off";
  return health.data === undefined ? null : policySandbox(health.data.enforcement);
};

/**
 * The Workbench header (ADR 023), one row: Back, the owner's tile, the Task's title with who owns
 * it, who asked, the brain it thinks with and where it runs, then an Attempt switcher once it was
 * retried, one Live or History tag for the Attempt shown, and whatever the Workbench adds at the end.
 */
export function WorkbenchHeader({
  tree,
  task,
  attempts,
  attempt,
  read,
  hobs,
  headingRef,
  back,
  onAttempt,
  end,
}: {
  tree: TaskTree;
  task: Task;
  attempts: ReadonlyArray<Attempt>;
  attempt: Attempt | null;
  read: ActivityRead;
  hobs: HobLookup;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Back to where the Workbench was opened from. */
  back: ReactNode;
  onAttempt: (attemptId: AttemptId) => void;
  /** What sits at the row's end, such as the chat toggle. */
  end?: ReactNode;
}) {
  const owner = hobs(task.ownerId);
  const running = attempt !== null && isLiveAttempt(attempt.state);
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-3">
      {back}
      <span
        aria-hidden
        className="flex size-hob-tile shrink-0 items-center justify-center rounded-tile bg-[color-mix(in_srgb,var(--hob)_30%,var(--color-card))]"
        style={{ "--hob": HOB_COLORS[owner.lookColor].hat } as CSSProperties}
      >
        <HobSprite hob={owner} size={27} state={running ? "working" : "idle"} />
      </span>
      <span className="flex min-w-[12rem] flex-1 flex-col">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="m-0 min-w-0 truncate font-heading text-lg leading-6 font-(--heading-weight) text-text-strong outline-none"
        >
          {taskTitle(task)}
        </h2>
        <Byline tree={tree} task={task} attempt={attempt} read={read} hobs={hobs} />
      </span>
      {attempts.length > 1 && attempt !== null && (
        <AttemptPicker attempts={attempts} chosen={attempt.id} onAttempt={onAttempt} />
      )}
      {attempt !== null && <AttemptTag running={running} />}
      {end}
    </header>
  );
}

/** "<owner> · asked by You → <lead> · <brain> · in the sandbox · Works in <folders>". */
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
    <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-detail leading-[18px] text-text-secondary">
      <span>{hobs(task.ownerId).name}</span>
      <Dot />
      <span>{messages.askedBy({ chain })}</span>
      {runtime !== null && <Brain runtime={runtime} model={model} />}
      {runtime !== null && <Where runtime={runtime} read={read} />}
      <Folders folders={memberFolders(tree, task)} />
    </span>
  );
}

/** The Back button the header leads with, named for where it returns. */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      ← {label}
    </Button>
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

/** In the sandbox, or the Unsandboxed tag. */
function Where({ runtime, read }: { runtime: Attempt["runtime"]; read: ActivityRead }) {
  const sandbox = useSandbox(runtime, read);
  if (sandbox === null) return null;
  return (
    <>
      <Dot />
      <span
        title={messages.sandboxHint[sandbox]}
        className={cn(
          sandbox === "off" && "rounded-tag border border-rose px-1.5 text-xs font-bold text-rose",
          sandbox === "unavailable" && "rounded-tag bg-line-2 px-1.5 text-xs font-bold text-text-secondary",
        )}
      >
        {sandbox === "on" ? messages.inSandboxLower : sandboxWords[sandbox]}
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

import { type Attempt, type AttemptId, isLiveAttempt, policySandbox, type Task, type TaskTree } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { agentsQuery, runtimesQuery } from "../../api/queries.ts";
import { RuntimeTile, useBrainLabel } from "../brain-picker.tsx";
import { HobSprite } from "../hob-sprite.tsx";
import { roomStatus, roomStatusLabel, roomTone } from "../quest/control-room.ts";
import { folderName, memberFolders } from "../quest/member-folders.ts";
import { StatusTag } from "../quest/status-dot.tsx";
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
 * The Workbench header (ADR 023): the Task's title and status, its owner and who asked, the brain
 * it thinks with, where it runs, and an Attempt picker once it was retried.
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
  const status = roomStatus(tree, task);
  const chain = [messages.you, ...askedBy(tree, task).map((id) => hobs(id).name)];
  const running = attempt !== null && isLiveAttempt(attempt.state);
  const agent = useQuery({ ...agentsQuery, select: (all) => all.find((each) => each.id === task.ownerId) }).data;
  // An Attempt records its runtime; before the first, the owner's is the one it will think with.
  const runtime = attempt?.runtime ?? agent?.runtime ?? null;
  // The model is the owner's while it thinks with that runtime.
  const model = agent?.runtime === runtime ? (agent?.model ?? null) : null;
  return (
    <header className="flex flex-col gap-2.5 border-b-4 border-line px-5 pt-3 pb-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="m-0 min-w-0 flex-1 truncate font-pixel text-xl font-semibold text-moonlight outline-none"
        >
          {taskTitle(task)}
        </h2>
        <StatusTag status={roomTone(status)}>{roomStatusLabel(status)}</StatusTag>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-detail text-secondary-text">
        <span className="flex items-center gap-2">
          <HobSprite hob={owner} size={22} state={running ? "working" : "idle"} />
          <span className="font-bold text-text">{owner.name}</span>
          <span>{messages.askedBy({ chain })}</span>
        </span>
        {runtime !== null && <Brain runtime={runtime} model={model} />}
        {runtime !== null && <Where runtime={runtime} read={read} />}
        <Folders folders={memberFolders(tree, task)} />
      </div>
      {attempts.length > 1 && attempt !== null && (
        <AttemptPicker attempts={attempts} chosen={attempt.id} onAttempt={onAttempt} />
      )}
    </header>
  );
}

/** The folders a member works in, by name, each full path in the hint. Nothing for work no lead gave. */
function Folders({ folders }: { folders: ReadonlyArray<string> | null }) {
  if (folders === null) return null;
  return (
    <span title={folders.join("\n")} className="min-w-0 truncate">
      {folders.length === 0 ? messages.noFolders : messages.worksIn({ names: folders.map(folderName) })}
    </span>
  );
}

/** The runtime's tile, runtime and model the Task thinks with. */
function Brain({ runtime, model }: { runtime: Attempt["runtime"]; model: string | null }) {
  const label = useBrainLabel({ runtime, model });
  return (
    <span className="flex items-center gap-2">
      <RuntimeTile runtime={runtime} />
      <span>{label}</span>
    </span>
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
    <span
      title={messages.sandboxHint[sandbox]}
      className={cn(
        sandbox === "off" && "border-2 border-rose px-tag-x py-0.5 text-xs font-bold text-rose",
        sandbox === "unavailable" && "bg-line-2 px-tag-x py-0.5 text-xs font-bold text-secondary-text",
      )}
    >
      {sandboxWords[sandbox]}
    </span>
  );
}

/** "Attempt 1 · 2 · 3": every tab follows the chosen one. */
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
    <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="sr-only">{messages.attempts}</legend>
      {attempts.map((each) => (
        <button
          key={each.id}
          type="button"
          aria-pressed={each.id === chosen}
          onClick={() => onAttempt(each.id)}
          className={cn(
            "cursor-pointer border-2 px-2.5 py-1 text-detail",
            each.id === chosen
              ? "border-moonlight bg-line text-moonlight"
              : "border-line-2 bg-transparent text-label hover:bg-hover hover:text-text",
          )}
        >
          {messages.attempt({ number: each.number })}
        </button>
      ))}
    </fieldset>
  );
}

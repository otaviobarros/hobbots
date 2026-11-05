import type { AgentId } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import { useState } from "react";
import { HobTile } from "../hob-sprite/hob-sprite.tsx";
import type { HobLookup } from "../quest/use-work.ts";
import { useLineCounts } from "../workbench/changes/use-line-counts.ts";
import type { LaneItem, LaneMark } from "./lane-model.ts";
import { messages } from "./messages.ts";

type Mark = Extract<LaneMark, { kind: "edit" }>;
type Run = Extract<LaneMark, { kind: "run" }>;

const GLYPH: Readonly<Record<LaneMark["kind"] | "refused", string>> = {
  read: "↗",
  edit: "✎",
  delete: "✕",
  run: "$",
  refused: "⊘",
};

/** Decorative marks for a beat and a wait; their words are always beside them. */
const BEAT = "◆";
const WAIT = "◷";

/** A compact mark: its glyph, what it was about in mono, and how it went. */
function MarkRow({
  kind,
  text,
  outcome,
  bad = false,
}: {
  kind: keyof typeof GLYPH;
  text: string;
  outcome?: { text: string; label: string } | null;
  bad?: boolean;
}) {
  return (
    <li className="flex items-baseline gap-2 ps-0.5 font-mono text-meta text-text-secondary">
      <span aria-hidden className="w-3 shrink-0 text-center text-label">
        {GLYPH[kind]}
      </span>
      <span className="sr-only">{messages.mark[kind]}</span>
      <code className="min-w-0 flex-1 truncate font-[inherit]" title={text}>
        {text}
      </code>
      {outcome && (
        <span className={cn("shrink-0", bad ? "text-rose" : "text-mint")}>
          <span aria-hidden>{outcome.text}</span>
          <span className="sr-only">{outcome.label}</span>
        </span>
      )}
    </li>
  );
}

/** An edit, with the lines it added once the kept versions are read. */
function EditRow({ mark }: { mark: Mark }) {
  const counts = useLineCounts(mark.change, mark.activity);
  const outcome =
    counts !== null && counts.added > 0
      ? { text: messages.added({ count: counts.added }), label: messages.addedLabel({ count: counts.added }) }
      : mark.change.kind === "added"
        ? { text: messages.newFile, label: messages.newFile }
        : null;
  return <MarkRow kind="edit" text={mark.path} outcome={outcome} />;
}

const runOutcome = ({ command }: Run) => {
  switch (command.state) {
    case "succeeded":
      return { text: messages.succeeded, label: messages.succeededLabel };
    case "failed":
      return command.exitCode === null
        ? { text: messages.failed, label: messages.failed }
        : { text: messages.exit({ code: command.exitCode }), label: messages.exit({ code: command.exitCode }) };
    case "running":
      return { text: "…", label: messages.running };
    case "uncertain":
      return { text: "?", label: messages.uncertain };
  }
};

function LaneMarkRow({ mark }: { mark: LaneMark }) {
  switch (mark.kind) {
    case "read":
      return <MarkRow kind="read" text={mark.path} />;
    case "edit":
      return <EditRow mark={mark} />;
    case "delete":
      return (
        <MarkRow kind="delete" text={mark.path} outcome={{ text: messages.deleted, label: messages.deleted }} bad />
      );
    case "run":
      return (
        <MarkRow
          kind="run"
          text={mark.command.command}
          outcome={runOutcome(mark)}
          bad={mark.command.state === "failed"}
        />
      );
  }
}

/** A Task's older marks folded into one count; opening it shows them where the first was. */
function Folded({ marks }: { marks: ReadonlyArray<LaneMark> }) {
  const [open, setOpen] = useState(false);
  if (open) return marks.map((mark) => <LaneMarkRow key={mark.key} mark={mark} />);
  return (
    <li>
      <button
        type="button"
        aria-label={messages.foldedLabel({ count: marks.length })}
        onClick={() => setOpen(true)}
        className="cursor-pointer border-0 bg-transparent p-0 ps-5 text-meta text-label underline underline-offset-2 hover:text-text-strong"
      >
        {messages.folded({ count: marks.length })}
      </button>
    </li>
  );
}

/** A chip for work moving between hobs, with the other hob's tile. */
function Chip({ hob, hobs, text }: { hob: AgentId | undefined; hobs: HobLookup; text: string }) {
  return (
    <li className="flex items-center gap-1.5 self-start rounded-dot bg-[color-mix(in_srgb,var(--color-star)_16%,var(--color-card))] py-0.5 ps-1 pe-2 text-detail text-text-strong">
      {hob !== undefined && <HobTile hob={hobs(hob)} tile="sm" />}
      <span>{text}</span>
    </li>
  );
}

const names = (ids: ReadonlyArray<AgentId>, hobs: HobLookup) => messages.names(ids.map((id) => hobs(id).name));

/** One thing a lane shows, as a list item. */
export function LaneItemRow({ item, hobs }: { item: LaneItem; hobs: HobLookup }) {
  switch (item.kind) {
    case "read":
    case "edit":
    case "delete":
    case "run":
      return <LaneMarkRow mark={item} />;
    case "folded":
      return <Folded marks={item.marks} />;
    case "beat":
      return (
        <li className="flex items-baseline gap-2 text-ui font-semibold text-text-strong">
          <span aria-hidden className="text-meta text-star">
            {BEAT}
          </span>
          <span className="min-w-0 truncate" title={item.text}>
            {item.text}
          </span>
        </li>
      );
    case "refused":
      return <MarkRow kind="refused" text={item.reason === "" ? item.what : `${item.what}: ${item.reason}`} bad />;
    case "hand-out":
      return (
        <Chip hob={item.to} hobs={hobs} text={messages.handOut({ label: item.label, name: hobs(item.to).name })} />
      );
    case "hand-in":
      return (
        <Chip hob={item.from} hobs={hobs} text={messages.handIn({ label: item.label, name: hobs(item.from).name })} />
      );
    case "briefed":
      return <Chip hob={item.members[0]} hobs={hobs} text={messages.briefed({ names: names(item.members, hobs) })} />;
    case "task":
      return <li className="pt-2 text-meta font-bold text-label">{item.title}</li>;
    default:
      return <LaneStatusRow item={item} hobs={hobs} />;
  }
}

/** The lines that say where the Task stands: a wait, a turn that runs now, or how it ended. */
function LaneStatusRow({
  item,
  hobs,
}: {
  item: Extract<LaneItem, { kind: "wait" | "now" | "result" }>;
  hobs: HobLookup;
}) {
  switch (item.kind) {
    case "wait": {
      const who = item.on.map((each) => (each.kind === "you" ? messages.you : hobs(each.id).name));
      return (
        <li className="flex items-center gap-2 text-detail text-lantern">
          <span aria-hidden>{WAIT}</span>
          <span>{messages.waits({ names: messages.names(who) })}</span>
        </li>
      );
    }
    case "now":
      return (
        <li className="flex items-center gap-2 text-detail text-mint">
          <span aria-hidden className="size-2 shrink-0 animate-hb-blink rounded-dot bg-mint" />
          <span className="min-w-0 truncate">{item.label ?? messages.now}</span>
        </li>
      );
    case "result":
      return (
        <li
          className={cn(
            // A result can quote a long folder path, which wraps rather than widening the lane.
            "rounded-control px-2 py-1.5 text-detail text-text wrap-anywhere",
            item.outcome === "completed"
              ? "bg-[color-mix(in_srgb,var(--color-mint)_12%,var(--color-card))]"
              : "bg-[color-mix(in_srgb,var(--color-rose)_12%,var(--color-card))]",
          )}
        >
          <b className={item.outcome === "completed" ? "text-mint" : "text-rose"}>{messages.result[item.outcome]}</b>
          {item.text !== null && ` · ${item.text}`}
          {item.text === null && item.outcome === "failed" && ` · ${messages.stoppedWhy}`}
        </li>
      );
  }
}

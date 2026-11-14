import type { Agent, AgentId, HobChange } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useRevertChange } from "../../api/hob-changes.ts";
import { useUpdatePermissions } from "../../api/queries.ts";
import { formatMoment } from "../../lib/format.ts";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { DiffLines } from "../skills/skill-diff.tsx";
import { canRevert, type FieldDiff, fieldDiffs, makerOf, restoreOf, type VersionChange } from "./hob-changes-model.ts";
import { HobName, NamingHob, namedIn, useHobsNamed } from "./hob-names.tsx";
import { messages } from "./messages.ts";

const copy = messages.row;

const titleOf = (change: HobChange, hob: Agent | undefined): string => {
  if (change._tag === "Version") {
    if (change.config.version > 1) return copy.version({ version: change.config.version });
    return change.actor._tag === "Hob" && hob?.summonedUnattended === true ? copy.summonedUnattended : copy.summoned;
  }
  if (change.status === "paused") return copy.paused;
  if (change.status === "retired") return copy.retired;
  return change.from === "retired" ? copy.broughtBack : copy.woke;
};

/** Who made the change, with the hob behind it linked to its profile. */
function MakerLine({ change, hobs }: { change: HobChange; hobs: ReadonlyMap<AgentId, Agent> }) {
  const maker = makerOf(change);
  if (maker.kind === "you") return <span>{copy.byYou}</span>;
  const line = maker.kind === "hob" ? (hob: string) => copy.byHob({ hob }) : (hob: string) => copy.byProposal({ hob });
  return <NamingHob hobId={maker.hobId} hobs={hobs} line={line} />;
}

/** The request behind a hob's change: the Charm it came through and the chat turn it was made in. */
function OriginLine({ change }: { change: HobChange }) {
  const origin = change.origin;
  if (origin === null || change.actor._tag === "You") return null;
  const hobId = change.actor.hobId;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {origin.charm !== null && (
        <span>{copy.viaCharm({ charm: messages.values.charms[origin.charm] ?? origin.charm })}</span>
      )}
      {origin.threadId !== null && (
        <Link
          to="/hobs/$hobId/threads/$threadId"
          params={{ hobId, threadId: origin.threadId }}
          search={{
            ...(origin.messageId === null ? {} : { message: origin.messageId }),
            ...(origin.taskId === null ? {} : { room: origin.taskId }),
          }}
          className="text-link underline-offset-2 hover:underline"
        >
          {origin.taskId === null ? copy.openChat : copy.openTask}
        </Link>
      )}
    </span>
  );
}

function FieldChange({ diff }: { diff: FieldDiff }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta font-semibold text-label">{diff.label}</span>
      {diff.lines ? (
        <div className="overflow-hidden rounded-control border border-line bg-deep">
          <DiffLines before={diff.before} after={diff.after} />
        </div>
      ) : (
        <span className="flex flex-wrap items-baseline gap-x-2 text-ui">
          {diff.before !== "" && (
            <>
              <span className="text-text-secondary line-through">{diff.before}</span>
              <span aria-hidden className="text-label">
                →
              </span>
            </>
          )}
          <span className="text-text-strong">{diff.after}</span>
        </span>
      )}
    </div>
  );
}

/** Revert for the hob's latest change, with what happened once it answers. */
function Revert({ change }: { change: VersionChange }) {
  const revert = useRevertChange(change.hobId);
  const notLatest = revert.error instanceof ApiError && revert.error.tag === "RevertRefused";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={revert.isPending}
        onClick={() => revert.mutate(change.config.version)}
      >
        {revert.isPending ? copy.reverting : copy.revert}
      </Button>
      <span className="text-meta text-label">{copy.revertNote({ version: change.config.version - 1 })}</span>
      {revert.isError && (
        <span role="alert" className="text-meta text-rose">
          {notLatest ? copy.notLatest : copy.revertFailed}
        </span>
      )}
    </div>
  );
}

/**
 * What a Summoning change dropped without naming it, with Restore them, which gives those answers
 * back as a change made by you (#1352). Nothing is restored until you press it.
 */
function RestoreAnswers({ change, hob }: { change: HobChange; hob: Agent | undefined }) {
  const restore = restoreOf(change, hob);
  const update = useUpdatePermissions(change.hobId);
  if (restore === null) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-line bg-deep px-3 py-2">
      <span className="text-meta text-text-secondary">{copy.dropped({ answers: restore.words })}</span>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={update.isPending}
          onClick={() => update.mutate(restore.payload)}
        >
          {update.isPending ? copy.restoring : copy.restore}
        </Button>
        {update.isError && (
          <span role="alert" className="text-meta text-rose">
            {copy.restoreFailed}
          </span>
        )}
      </div>
    </div>
  );
}

/** One change: what happened and when, who made it and why, what it changed, and Revert when it can. */
function ChangeRow({
  change,
  hobs,
  showHob,
  latest,
}: {
  change: HobChange;
  hobs: ReadonlyMap<AgentId, Agent>;
  /** Whether the row names the hob it changed, as the Changes log does. */
  showHob: boolean;
  /** Whether it is the newest change of the list. */
  latest: boolean;
}) {
  const [open, setOpen] = useState(latest);
  const target = hobs.get(change.hobId);
  const diffs =
    change._tag === "Version" ? fieldDiffs(change, (id) => hobs.get(id as AgentId)?.name ?? messages.someHob) : [];
  const revertable = change._tag === "Version" && canRevert(change, target);
  return (
    <li
      className={cn(
        // A history grows with every change: only the rows near the viewport are laid out (STD-REACT-024).
        "flex gap-3 rounded-card px-3.5 py-3 [contain-intrinsic-size:auto_72px] [content-visibility:auto]",
        change.actor._tag === "Hob" ? "bg-[color-mix(in_srgb,var(--color-lantern)_8%,var(--color-card))]" : "bg-card",
      )}
    >
      {showHob && target !== undefined && (
        <span className="flex size-9 flex-none items-end justify-center">
          <HobSprite hob={target} size={28} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          {showHob && (
            <span className="text-ui">
              <HobName hobId={change.hobId} hobs={hobs} />
            </span>
          )}
          <span className="text-ui font-semibold text-text-strong">{titleOf(change, target)}</span>
          <time dateTime={change.at} className="text-meta text-label">
            {formatMoment(change.at)}
          </time>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-secondary">
          <MakerLine change={change} hobs={hobs} />
          <OriginLine change={change} />
        </div>
        {diffs.length > 0 && (
          <>
            <Button
              type="button"
              variant="quiet"
              size="xs"
              className="self-start"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
            >
              {open ? copy.hideDiff : copy.showDiff}
            </Button>
            {open && (
              <div className="flex flex-col gap-2.5">
                {diffs.map((diff) => (
                  <FieldChange key={diff.key} diff={diff} />
                ))}
              </div>
            )}
          </>
        )}
        {change._tag === "Version" && diffs.length === 0 && (
          <span className="text-meta text-label">{copy.unchanged}</span>
        )}
        <RestoreAnswers change={change} hob={target} />
        {revertable && change._tag === "Version" && <Revert change={change} />}
      </div>
    </li>
  );
}

/** Changes to hobs, newest first, as a hob's History and the Changes log show them. */
export function ChangeList({
  changes,
  label,
  showHob,
}: {
  changes: ReadonlyArray<HobChange>;
  label: string;
  showHob: boolean;
}) {
  const hobs = useHobsNamed(namedIn(changes));
  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {changes.map((change, at) => (
        <ChangeRow
          key={`${change.hobId}/${change._tag}/${change._tag === "Version" ? change.config.version : change.at}`}
          change={change}
          hobs={hobs}
          showHob={showHob}
          latest={at === 0 && !showHob}
        />
      ))}
    </ol>
  );
}

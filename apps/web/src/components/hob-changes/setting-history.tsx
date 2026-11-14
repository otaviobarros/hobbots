import type { SettingChangesLog } from "@hobbots/api";
import type { AgentId, SettingChange, SettingDiff } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { settingChangesQuery } from "../../api/hob-changes.ts";
import { formatMoment } from "../../lib/format.ts";
import type { SettingsSection } from "../settings/sections.ts";
import { FieldChange } from "./change-list.tsx";
import { useHobsNamed } from "./hob-names.tsx";
import { messages } from "./messages.ts";
import { settingLines, settingMakerLine, settingTitle } from "./setting-change-model.ts";

const copy = messages.settings;

/** Where Settings keeps each setting: the preset and the folders in Safety, Summoning in Connections. */
const SECTION_OF: Readonly<Record<SettingDiff["setting"], SettingsSection>> = {
  safetyPreset: "safety",
  approvedFolders: "safety",
  summoningForEveryHob: "connections",
};

/** The hobs a change names, such as those picked for Summoning's scope. */
const pickedHobs = (changes: ReadonlyArray<SettingChange>): ReadonlyArray<AgentId> =>
  changes.flatMap(({ diff }) =>
    diff.setting === "summoningForEveryHob"
      ? [...(diff.before?.scope.hobs ?? []), ...(diff.after?.scope.hobs ?? [])].map((id) => id as AgentId)
      : [],
  );

/** One setting change: what changed and when, who changed it, and what it moved, open on request. */
function SettingRow({ change, nameOf }: { change: SettingChange; nameOf: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const lines = settingLines(change.diff, nameOf);
  return (
    <li className="flex flex-col gap-1.5 rounded-card bg-card px-3.5 py-3 [contain-intrinsic-size:auto_72px] [content-visibility:auto]">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-ui font-semibold text-text-strong">{settingTitle(change.diff)}</span>
        <time dateTime={change.at} className="text-meta text-label">
          {formatMoment(change.at)}
        </time>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-text-secondary">
        <span>{settingMakerLine(change)}</span>
        <Link
          to="/settings/$section"
          params={{ section: SECTION_OF[change.diff.setting] }}
          // Summoning for every hob is on the Charms tab of Connections.
          search={change.diff.setting === "summoningForEveryHob" ? { tab: "charms" } : {}}
          className="text-link underline-offset-2 hover:underline"
        >
          {copy.openSettings}
        </Link>
      </div>
      {lines.length > 0 && (
        <>
          <Button
            type="button"
            variant="quiet"
            size="xs"
            className="self-start"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? messages.row.hideDiff : messages.row.showDiff}
          </Button>
          {open && (
            <div className="flex flex-col gap-2.5">
              {lines.map((line) => (
                <FieldChange key={line.label} diff={line} />
              ))}
            </div>
          )}
        </>
      )}
    </li>
  );
}

/**
 * The history of the hub settings that change what hobs may do (#1357): the preset, the folders hobs
 * can open and Summoning for every hob, newest first. It follows the hub's events, so a change made on
 * another device shows live.
 */
export function SettingHistory() {
  const log = useQuery(settingChangesQuery);
  const changes = log.data?.changes ?? [];
  const hobs = useHobsNamed(pickedHobs(changes));
  const headingId = useId();
  const nameOf = (id: string) => hobs.get(id as AgentId)?.name ?? messages.someHob;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="m-0 text-ui font-semibold text-text-strong">
        {copy.heading}
      </h3>
      <p className="m-0 text-detail text-text-secondary">{copy.intro}</p>
      <SettingHistoryBody log={log} nameOf={nameOf} />
    </section>
  );
}

/** The list once it is read, a wait while it is read, or what went wrong with Try again (STD-REACT-015). */
function SettingHistoryBody({
  log,
  nameOf,
}: {
  log: UseQueryResult<SettingChangesLog>;
  nameOf: (id: string) => string;
}) {
  if (log.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{messages.history.waiting}</span>
        <Skeleton surface="card" width="50%" />
      </div>
    );
  }
  if (log.isError) {
    return (
      <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
        <span role="alert">{copy.failed}</span>
        <Button type="button" variant="chip" size="xs" onClick={() => void log.refetch()}>
          {messages.history.retry}
        </Button>
      </p>
    );
  }
  const { changes, more } = log.data;
  if (changes.length === 0) return <p className="m-0 text-ui text-text-secondary">{copy.empty}</p>;
  return (
    <>
      <ol aria-label={copy.heading} className="m-0 flex list-none flex-col gap-1.5 p-0">
        {changes.map((change) => (
          <SettingRow key={change.id} change={change} nameOf={nameOf} />
        ))}
      </ol>
      {more && <p className="m-0 text-meta text-label">{copy.more({ count: changes.length })}</p>}
    </>
  );
}

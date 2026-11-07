import type { HobSkills, SkillsList } from "@hobbots/api";
import { type Agent, skillRevisionLabel } from "@hobbots/domain";
import { Switch } from "@hobbots/ui/components/switch";
import { Link } from "@tanstack/react-router";
import { messages as shared } from "../messages.ts";
import { RowList } from "../memory/memory-overview.tsx";
import { type HobDirectory, projectName, scopeName, skillsSearchOf, skillTitle, skillView } from "../skills/skills-model.ts";
import { RevTag, SkillChip } from "../skills/skills-parts.tsx";
import { type CarriedGroup, type CarriedRow, carriedGroups } from "./hob-skills-model.ts";
import { messages } from "./messages.ts";
import { useHobSkillWrites } from "./use-hob-skill-writes.ts";

const copy = messages.carries;

/** A Charm's name as the app shows it, such as GitHub. */
export const charmName = (charm: string): string =>
  charm === "github" ? shared.charms.github.name : charm.charAt(0).toUpperCase() + charm.slice(1);

const headingOf = (group: CarriedGroup, hob: Agent) => {
  switch (group.scope._tag) {
    case "Everyone":
      return { title: copy.fromEveryone, line: null };
    case "Project":
      return {
        title: copy.fromProject({ name: projectName(group.scope.identity) }),
        line: copy.because({ name: hob.name, identity: group.scope.identity }),
      };
    case "Hob":
      return { title: copy.own({ name: hob.name }), line: null };
  }
};

/** The notes beside a carried skill: why it does not load, or how it loads. */
function RowNotes({ row, hob, hobs }: { row: CarriedRow; hob: Agent; hobs: HobDirectory }) {
  const notes: Array<{ key: string; tone: "later" | "waiting" | "needs"; text: string }> = [];
  if (row.state._tag === "Off") notes.push({ key: "off", tone: "later", text: copy.off({ name: hob.name }) });
  if (row.state._tag === "Replaced")
    notes.push({ key: "replaced", tone: "later", text: copy.replaced({ by: scopeName(row.state.by, hobs) }) });
  if (row.state._tag === "Clash") notes.push({ key: "clash", tone: "needs", text: copy.clash });
  if (row.onlyWhenAsked) notes.push({ key: "asked", tone: "waiting", text: copy.onlyWhenAsked });
  for (const charm of row.missingCharms)
    notes.push({ key: `charm-${charm}`, tone: "needs", text: copy.needs({ charm: charmName(charm) }) });
  if (row.newer !== null)
    notes.push({
      key: "newer",
      tone: "later",
      text: copy.available({ rev: skillRevisionLabel({ number: row.newer }), held: row.held }),
    });
  return (
    <>
      {notes.map((note) => (
        <SkillChip key={note.key} tone={note.tone}>
          {note.text}
        </SkillChip>
      ))}
    </>
  );
}

function Row({
  row,
  hob,
  hobs,
  onSwitch,
  busy,
}: {
  row: CarriedRow;
  hob: Agent;
  hobs: HobDirectory;
  onSwitch: (row: CarriedRow, on: boolean) => void;
  busy: boolean;
}) {
  const title = skillTitle(row.skill.name);
  // A shared skill that loads, or one turned off, can be switched for this hob alone.
  const switchable = row.scope._tag !== "Hob" && (row.state._tag === "Loads" || row.state._tag === "Off");
  return (
    <li className="flex flex-wrap items-center gap-2.5 bg-card px-3.5 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <Link
            to="/skills"
            search={skillsSearchOf(skillView(row.skill.id))}
            className="truncate text-ui font-semibold text-text-strong no-underline hover:underline"
          >
            {title}
          </Link>
          {row.number !== null && <RevTag label={skillRevisionLabel({ number: row.number })} />}
          <RowNotes row={row} hob={hob} hobs={hobs} />
        </span>
        <span className="truncate text-meta text-label">{row.skill.description}</span>
      </span>
      {switchable && (
        <Switch
          aria-label={copy.uses({ name: hob.name, skill: title })}
          checked={row.state._tag === "Loads"}
          disabled={busy}
          onCheckedChange={(on) => onSwitch(row, on)}
        />
      )}
    </li>
  );
}

/**
 * What a hob carries (ADR 029, Scopes), by where it comes from: Everyone, each project it works in,
 * and its own, with a switch to turn a shared skill off for this hob alone. Clashes, replaced skills
 * and held revisions say so on their row.
 */
export function HobCarries({
  hob,
  view,
  list,
  hobs,
  onSaid,
}: {
  hob: Agent;
  view: HobSkills;
  list: SkillsList;
  hobs: HobDirectory;
  onSaid: (message: string, failed?: boolean) => void;
}) {
  const writes = useHobSkillWrites();
  const groups = carriedGroups(view, list);
  const onSwitch = (row: CarriedRow, on: boolean) => {
    const skill = skillTitle(row.skill.name);
    writes.optOut.mutate(
      { agentId: hob.id, skillId: row.skill.id, optedOut: !on },
      {
        onSuccess: () =>
          onSaid(on ? copy.turnedOn({ name: hob.name, skill }) : copy.turnedOff({ name: hob.name, skill })),
        onError: () => onSaid(copy.failed, true),
      },
    );
  };
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => {
        const { title, line } = headingOf(group, hob);
        return (
          <section key={group.key} aria-label={title} className="flex flex-col gap-1.5">
            <h3 className="lbl m-0 text-label">{title}</h3>
            {line !== null && <p className="m-0 text-detail text-text-secondary">{line}</p>}
            {group.rows.length === 0 ? (
              <p className="m-0 text-ui text-text-secondary">
                {group.scope._tag === "Hob" ? copy.noneOwn({ name: hob.name }) : copy.none}
              </p>
            ) : (
              <RowList label={title}>
                {group.rows.map((row) => (
                  <Row
                    key={`${row.skill.id}-${row.state._tag}`}
                    row={row}
                    hob={hob}
                    hobs={hobs}
                    onSwitch={onSwitch}
                    busy={writes.busy}
                  />
                ))}
              </RowList>
            )}
          </section>
        );
      })}
      <p className="m-0 text-detail text-label">{copy.foot({ name: hob.name })}</p>
    </div>
  );
}

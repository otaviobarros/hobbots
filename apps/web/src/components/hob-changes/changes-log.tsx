import type { AgentId } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { changesLogQuery } from "../../api/hob-changes.ts";
import { ChangeList } from "./change-list.tsx";
import { type ChangeFilters, filterChoices, matchesFilters, NO_FILTERS } from "./hob-changes-model.ts";
import { namedIn, useHobsNamed } from "./hob-names.tsx";
import { messages } from "./messages.ts";

const copy = messages.log;
// A select's value for "any", which no hob id or Charm name can be.
const ANY = "*";

/** One filter: a label and its choices, Any first. */
function FilterSelect({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string | null;
  choices: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  return (
    <span className="flex items-center gap-2">
      <label htmlFor={id} className="text-meta text-label">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ANY}
        onChange={(event) => onChange(event.target.value === ANY ? null : event.target.value)}
        className="min-w-0 rounded-control border-(length:--edge) border-control bg-deep px-2 py-1 text-detail text-text-strong"
      >
        <option value={ANY}>{copy.any}</option>
        {choices.map(([choice, name]) => (
          <option key={choice} value={choice}>
            {name}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Settings › Changes (ADR 034): every change to every hob, newest first, filterable by the hob it
 * changed, who made it and the Charm it came through. It follows the hub's events, so a change made
 * by a hob or on another device shows live.
 */
export function ChangesLog() {
  const log = useQuery(changesLogQuery);
  const [filters, setFilters] = useState<ChangeFilters>(NO_FILTERS);
  const changes = log.data?.changes ?? [];
  const hobs = useHobsNamed(namedIn(changes));
  const choices = filterChoices(changes);
  const nameOf = (id: AgentId) => hobs.get(id)?.name ?? messages.someHob;
  const shown = changes.filter((change) => matchesFilters(change, filters));

  if (log.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{messages.history.waiting}</span>
        <Skeleton surface="card" width="60%" />
        <Skeleton surface="card" width="40%" />
      </div>
    );
  }
  if (log.isError) {
    return (
      <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
        <span role="alert">{messages.history.failed}</span>
        <Button type="button" variant="chip" size="xs" onClick={() => void log.refetch()}>
          {messages.history.retry}
        </Button>
      </p>
    );
  }
  if (changes.length === 0) return <p className="m-0 text-ui text-text-secondary">{messages.history.empty}</p>;
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-wrap items-center gap-x-4 gap-y-2 border-0 p-0">
        <legend className="sr-only">{copy.filters}</legend>
        <FilterSelect
          label={copy.hob}
          value={filters.hob}
          choices={choices.hobs.map((id) => [id, nameOf(id)] as const)}
          onChange={(hob) => setFilters((was) => ({ ...was, hob: hob as AgentId | null }))}
        />
        <FilterSelect
          label={copy.actor}
          value={filters.actor}
          choices={choices.actors.map((actor) => [actor, actor === "you" ? copy.you : nameOf(actor)] as const)}
          onChange={(actor) => setFilters((was) => ({ ...was, actor: actor as ChangeFilters["actor"] }))}
        />
        <FilterSelect
          label={copy.charm}
          // An empty Charm name is a change made through none, which the select keeps as its own choice.
          value={filters.charm}
          choices={choices.charms.map((charm) => [charm, charm === "" ? copy.noCharm : charm] as const)}
          onChange={(charm) => setFilters((was) => ({ ...was, charm }))}
        />
      </fieldset>
      {shown.length === 0 ? (
        <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
          <span>{copy.none}</span>
          <Button type="button" variant="chip" size="xs" onClick={() => setFilters(NO_FILTERS)}>
            {copy.clear}
          </Button>
        </p>
      ) : (
        <ChangeList changes={shown} label={copy.heading} showHob />
      )}
      {log.data.more && <p className="m-0 text-meta text-label">{copy.more({ count: changes.length })}</p>}
    </div>
  );
}

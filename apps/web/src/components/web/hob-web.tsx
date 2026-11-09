import type { HobPermissions } from "@hobbots/api";
import {
  type Agent,
  type Grant,
  type HobWebLimits,
  isLiveGrant,
  NO_HOB_WEB_LIMITS,
  type WebLimits,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { notOffered } from "../../api/enforcement.ts";
import { grantsQuery, useRevokeGrant } from "../../api/grants.ts";
import { ANSWER, offeredAnswer, presetInfo } from "../../api/safety.ts";
import { hobWebLimitsQuery, useSetHobWebLimits } from "../../api/web.ts";
import { formatDay } from "../../lib/time.ts";
import { messages } from "./messages.ts";
import { WebIcon } from "./reply-web.tsx";

const NEW_SITE = { allow: "allow", ask: "ask", deny: "never" } as const;

/** The hob's saved Always rules for reading the web, oldest first (ADR 036). */
const siteGrants = (grants: ReadonlyArray<Grant>, hob: Agent, now: string) =>
  grants
    .filter(
      (grant) =>
        grant.agentId === hob.id &&
        grant.operation === "use-web" &&
        grant.rule._tag === "Host" &&
        grant.lifetime === "always" &&
        isLiveGrant(grant, now),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

/**
 * Site rules (ADR 036): the hosts a hob may read pages on because you answered Always for them, each
 * with Remove, under what a new site does at the hob's answer for Use the web.
 */
export function SiteRules({ hob, permissions }: { hob: Agent; permissions: HobPermissions }) {
  const copy = messages.rules;
  const grants = useQuery(grantsQuery);
  const revoke = useRevokeGrant();
  const rules = siteGrants(grants.data ?? [], hob, new Date().toISOString());
  const newSite = NEW_SITE[offeredAnswer("use-web", permissions.decisions["use-web"])];
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-1.5">
      <h2 className="lbl m-0 text-label">{copy.heading}</h2>
      <p className="m-0 text-detail text-text-secondary">
        {copy.intro({ preset: presetInfo(permissions.preset).label, newSite })}
      </p>
      {grants.isSuccess && rules.length === 0 && <p className="m-0 text-ui text-text-secondary">{copy.none}</p>}
      {rules.length > 0 && (
        <ul aria-label={copy.heading} className="m-0 flex list-none flex-col gap-0.5 p-0">
          {rules.map((grant) => {
            const host = grant.rule._tag === "Host" ? grant.rule.host : "";
            const date = formatDay(grant.createdAt);
            const removing = revoke.isPending && revoke.variables === grant.id;
            return (
              <li key={grant.id} className="flex flex-wrap items-center gap-3 rounded-control bg-card px-3.5 py-2">
                <span className="min-w-0 flex-1 font-mono text-code break-all text-text-strong">{host}</span>
                <span className="text-meta text-text-secondary">
                  {grant.approvalId === null ? copy.saved({ date }) : copy.savedInChat({ date })}
                </span>
                <Badge variant="done">{copy.allow}</Badge>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={copy.removeLabel({ host })}
                  aria-disabled={revoke.isPending}
                  onClick={() => !revoke.isPending && revoke.mutate(grant.id)}
                >
                  {removing ? copy.removing : copy.remove}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {revoke.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.failed}
        </p>
      )}
      <p className="m-0 text-detail text-text-secondary">{copy.alwaysAsk({ name: hob.name })}</p>
    </section>
  );
}

const LIMIT_KEYS = ["searchesPerTurn", "pagesPerTurn", "searchesPerDay"] as const;

/**
 * Web limits (ADR 036): the searches and pages a turn and the searches a day that hold for the hob,
 * from Settings › Web or its own, with Set for the hob and Use Settings › Web.
 */
export function HobWebLimitsRow({ hob }: { hob: Agent }) {
  const copy = messages.limits;
  const view = useQuery(hobWebLimitsQuery(hob.id));
  const set = useSetHobWebLimits(hob.id);
  const [editing, setEditing] = useState(false);
  const data = view.data;
  const own = data !== undefined && LIMIT_KEYS.some((key) => data.overrides[key] !== null);
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-1.5">
      <h2 className="lbl m-0 text-label">{copy.heading}</h2>
      {data !== undefined && !editing && (
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-card px-3.5 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-text-strong">{copy.summary(data.effective)}</span>
            <span className="text-detail text-text-secondary">{own ? copy.own({ name: hob.name }) : copy.shared}</span>
          </span>
          {own && (
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={set.isPending}
              onClick={() => !set.isPending && set.mutate(NO_HOB_WEB_LIMITS)}
            >
              {copy.useShared}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {copy.setFor({ name: hob.name })}
          </Button>
        </div>
      )}
      {data !== undefined && editing && (
        <LimitsForm
          start={data.effective}
          pending={set.isPending}
          onSave={(limits) => set.mutate(limits, { onSuccess: () => setEditing(false) })}
          onCancel={() => setEditing(false)}
        />
      )}
      {set.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.failed}
        </p>
      )}
    </section>
  );
}

/** The three limits as number fields, saved together as the hob's own. */
function LimitsForm({
  start,
  pending,
  onSave,
  onCancel,
}: {
  start: WebLimits;
  pending: boolean;
  onSave: (limits: HobWebLimits) => void;
  onCancel: () => void;
}) {
  const copy = messages.limits;
  const [values, setValues] = useState<Record<(typeof LIMIT_KEYS)[number], string>>({
    searchesPerTurn: String(start.searchesPerTurn),
    pagesPerTurn: String(start.pagesPerTurn),
    searchesPerDay: String(start.searchesPerDay),
  });
  const id = useId();
  const parsed = (key: (typeof LIMIT_KEYS)[number]) => {
    const value = Number(values[key]);
    return values[key].trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : null;
  };
  const valid = LIMIT_KEYS.every((key) => parsed(key) !== null);
  return (
    <form
      className="flex flex-col gap-2.5 rounded-control bg-card px-3.5 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || pending) return;
        onSave({
          searchesPerTurn: parsed("searchesPerTurn"),
          pagesPerTurn: parsed("pagesPerTurn"),
          searchesPerDay: parsed("searchesPerDay"),
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="flex flex-wrap gap-3">
        {LIMIT_KEYS.map((key) => (
          <label key={key} htmlFor={`${id}-${key}`} className="flex flex-col gap-1 text-meta text-label">
            {copy[key]}
            <Input
              id={`${id}-${key}`}
              type="number"
              min={0}
              max={100_000}
              inputMode="numeric"
              value={values[key]}
              onChange={(event) => setValues((old) => ({ ...old, [key]: event.target.value }))}
              className="w-32"
            />
          </label>
        ))}
      </div>
      <span className="flex flex-wrap gap-2">
        <Button type="submit" variant="default" size="sm" disabled={!valid} aria-disabled={pending}>
          {pending ? copy.saving : copy.save}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </span>
    </form>
  );
}

const RUNTIMES = ["claude-code", "codex"] as const;

/**
 * Built in, on a hob's Charms tab (ADR 036): Web search and Reading pages, which every hob has,
 * each with its answer in Permissions and how each runtime does it, the hob's own runtime named.
 */
export function BuiltInCharms({ hob, permissions }: { hob: Agent; permissions: HobPermissions | undefined }) {
  const copy = messages.builtIn;
  const answerOf = (operation: "search-web" | "use-web") =>
    permissions === undefined
      ? null
      : notOffered(operation, permissions.enforcement)
        ? copy.notOffered
        : ANSWER[offeredAnswer(operation, permissions.decisions[operation])];
  const cards = [
    { key: "search", icon: "search", words: copy.search, answer: answerOf("search-web") },
    { key: "pages", icon: "page", words: copy.pages, answer: answerOf("use-web") },
  ] as const;
  return (
    <section aria-label={copy.heading} className="flex flex-col gap-2">
      <h2 className="lbl m-0 text-label">{copy.heading}</h2>
      <p className="m-0 -mt-1 text-detail text-text-secondary">{copy.intro({ name: hob.name })}</p>
      {cards.map((card) => (
        <article
          key={card.key}
          aria-label={card.words.name}
          className="flex flex-col gap-3 rounded-card bg-card px-4 py-3.5"
        >
          <header className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid size-8 flex-none place-items-center rounded-control bg-line text-text-strong"
            >
              <WebIcon kind={card.icon} size={16} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-ui font-bold text-text-strong">{card.words.name}</h3>
                {card.answer !== null && <Badge variant="muted">{card.answer}</Badge>}
              </span>
              <span className="text-detail text-text-secondary">{card.words.what({ answer: card.answer ?? "…" })}</span>
            </span>
            <Button asChild variant="ghost" size="sm">
              <Link to="/hobs/$hobId/profile" params={{ hobId: hob.id }} search={{ tab: "permissions" }}>
                {copy.inPermissions}
              </Link>
            </Button>
          </header>
          <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 rounded-control bg-deep px-3 py-2.5 text-detail">
            {RUNTIMES.map((runtime) => (
              <Fragment key={runtime}>
                <dt className="flex items-center gap-2 text-text-secondary">
                  {copy.runtime[runtime]}
                  {hob.runtime === runtime && <Badge variant="working">{copy.thisHob({ name: hob.name })}</Badge>}
                </dt>
                <dd className="m-0 text-text">{card.words[runtime === "claude-code" ? "claude" : "codex"]}</dd>
              </Fragment>
            ))}
          </dl>
        </article>
      ))}
    </section>
  );
}

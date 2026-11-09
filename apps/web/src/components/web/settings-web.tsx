import { DEFAULT_WEB_LIMITS, type WebLimits, type WebSettings } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useSetWebSettings, webSettingsQuery } from "../../api/web.ts";
import { SettingsGroup } from "../settings/settings-group.tsx";
import { messages } from "./messages.ts";
import { ReadFailed } from "./read-failed.tsx";
import { CacheGroup, LeavesGroup } from "./settings-web-groups.tsx";

const copy = messages.settings;

const LIMIT_KEYS = ["searchesPerTurn", "pagesPerTurn", "searchesPerDay"] as const;
type LimitKey = (typeof LIMIT_KEYS)[number];

/** A limit as typed, or null when it is not a whole number the hub takes. */
const limitOf = (typed: string): number | null => {
  const value = Number(typed);
  return typed.trim() !== "" && Number.isInteger(value) && value >= 0 && value <= 100_000 ? value : null;
};

/**
 * Settings › Web (ADR 036): the limits every hob has, the sites hobs never read, what leaves your
 * computer when a hob searches or reads a page, and the hub's page cache with Clear now.
 */
export function WebSection() {
  const settings = useQuery(webSettingsQuery);
  const save = useSetWebSettings();
  const data = settings.data;
  if (data === undefined) {
    return settings.isError ? (
      <ReadFailed text={copy.readFailed} onRetry={() => void settings.refetch()} />
    ) : (
      <div role="status">
        <span className="sr-only">{messages.reading}</span>
        <Skeleton surface="card" width="60%" />
      </div>
    );
  }
  // Saves queue one after another, each over the one before (`useSetWebSettings`); what you typed
  // is cleared only once it is saved, and a failure shows below (STD-REACT-016).
  const send = (change: Partial<WebSettings>, saved: () => void) =>
    void save.mutateAsync(change).then(saved, () => undefined);
  return (
    <>
      <LimitsGroup
        limits={data.limits}
        pending={save.isPending}
        onSave={(limits, saved) => send({ limits }, saved)}
        saved={save.isSuccess}
      />
      <BlockedGroup
        sites={data.blockedSites}
        pending={save.isPending}
        onChange={(blockedSites, saved) => send({ blockedSites }, saved)}
      />
      {save.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {save.error instanceof ApiError && save.error.tag === "InvalidWebSettings" ? save.error.message : copy.failed}
        </p>
      )}
      <LeavesGroup />
      <CacheGroup />
    </>
  );
}

/**
 * The three limits as one draft, saved when you leave a field or press Enter, with Reset to the
 * defaults. Every field you changed is saved together, and stays as you typed it until it is saved.
 */
function LimitsGroup({
  limits,
  pending,
  onSave,
  saved,
}: {
  limits: WebLimits;
  pending: boolean;
  onSave: (limits: WebLimits, saved: () => void) => void;
  saved: boolean;
}) {
  const id = useId();
  const [typed, setTyped] = useState<Partial<Record<LimitKey, string>>>({});
  const shown = (key: LimitKey) => typed[key] ?? String(limits[key]);
  /** Forgets each field typed as `next` saved it; one typed again since stays. */
  const forgetSaved = (next: WebLimits) =>
    setTyped((old) =>
      Object.fromEntries(Object.entries(old).filter(([key, value]) => limitOf(value ?? "") !== next[key as LimitKey])),
    );
  const commit = () => {
    const searchesPerTurn = limitOf(shown("searchesPerTurn"));
    const pagesPerTurn = limitOf(shown("pagesPerTurn"));
    const searchesPerDay = limitOf(shown("searchesPerDay"));
    if (searchesPerTurn === null || pagesPerTurn === null || searchesPerDay === null) return;
    const next: WebLimits = { searchesPerTurn, pagesPerTurn, searchesPerDay };
    // While a save runs, the limits shown may be about to change, so the draft is saved all the same.
    if (!pending && LIMIT_KEYS.every((key) => next[key] === limits[key])) return setTyped({});
    onSave(next, () => forgetSaved(next));
  };
  const isDefault = LIMIT_KEYS.every((key) => limits[key] === DEFAULT_WEB_LIMITS[key]);
  return (
    <SettingsGroup label={copy.limits}>
      <div className="flex flex-col gap-1">
        {LIMIT_KEYS.map((key) => {
          const invalid = limitOf(shown(key)) === null;
          return (
            <div key={key} className="flex items-center gap-3 rounded-control bg-card px-3.5 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <label htmlFor={`${id}-${key}`} className="text-text-strong">
                  {copy[key].label}
                </label>
                <span id={`${id}-${key}-note`} className="text-detail text-text-secondary">
                  {invalid ? <span className="text-rose">{copy.invalidLimit}</span> : copy[key].note}
                </span>
              </span>
              <Input
                id={`${id}-${key}`}
                type="number"
                min={0}
                max={100_000}
                inputMode="numeric"
                aria-describedby={`${id}-${key}-note`}
                aria-invalid={invalid}
                value={shown(key)}
                onChange={(event) => setTyped((old) => ({ ...old, [key]: event.target.value }))}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit();
                }}
                variant="number"
                className="w-[88px]"
              />
            </div>
          );
        })}
      </div>
      <p className="m-0 text-detail text-text-secondary">
        {copy.limitsNote}{" "}
        {!isDefault && (
          <Button
            variant="quiet"
            size="xs"
            aria-disabled={pending}
            onClick={() => !pending && onSave(DEFAULT_WEB_LIMITS, () => setTyped({}))}
          >
            {copy.reset}
          </Button>
        )}
        {pending ? (
          <span role="status" className="ms-1">
            {copy.saving}
          </span>
        ) : (
          saved && (
            <span role="status" className="ms-1 text-mint">
              {copy.saved}
            </span>
          )
        )}
      </p>
    </SettingsGroup>
  );
}

/** The sites hobs never read, each with Remove, and a field to block another. */
function BlockedGroup({
  sites,
  pending,
  onChange,
}: {
  sites: ReadonlyArray<string>;
  pending: boolean;
  onChange: (sites: ReadonlyArray<string>, saved: () => void) => void;
}) {
  const [site, setSite] = useState("");
  const trimmed = site.trim();
  return (
    <SettingsGroup label={copy.blocked}>
      {sites.length === 0 ? (
        <p className="m-0 text-ui text-text-secondary">{copy.blockedNone}</p>
      ) : (
        <ul aria-label={copy.blocked} className="m-0 flex list-none flex-col gap-1 p-0">
          {sites.map((blocked) => (
            <li key={blocked} className="flex items-center gap-3 rounded-control bg-card px-3.5 py-2">
              <span className="min-w-0 flex-1 font-mono text-code break-all text-text-strong">{blocked}</span>
              <Button
                variant="ghost"
                size="xs"
                aria-label={copy.removeLabel({ site: blocked })}
                aria-disabled={pending}
                onClick={() =>
                  !pending &&
                  onChange(
                    sites.filter((each) => each !== blocked),
                    () => {},
                  )
                }
              >
                {copy.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || pending) return;
          // The site stays in the field until it is saved, so a failed save loses nothing.
          if (sites.includes(trimmed)) setSite("");
          else onChange([...sites, trimmed], () => setSite(""));
        }}
      >
        <Input
          aria-label={copy.blockLabel}
          placeholder={copy.blockPlaceholder}
          value={site}
          onChange={(event) => setSite(event.target.value)}
          className="flex-1"
        />
        <Button type="submit" variant="outline" disabled={trimmed === ""} aria-disabled={pending}>
          {pending ? copy.saving : copy.block}
        </Button>
      </form>
      <p className="m-0 text-detail text-text-secondary">{copy.blockedNote}</p>
    </SettingsGroup>
  );
}

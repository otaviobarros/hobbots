import { DEFAULT_WEB_LIMITS, type WebLimits, type WebSettings } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Input } from "@hobbots/ui/components/input";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { pageCacheQuery, useClearPageCache, useSetWebSettings, webSettingsQuery } from "../../api/web.ts";
import { SettingsGroup } from "../settings/settings-group.tsx";
import { messages } from "./messages.ts";

const copy = messages.settings;

const LIMIT_KEYS = ["searchesPerTurn", "pagesPerTurn", "searchesPerDay"] as const;
type LimitKey = (typeof LIMIT_KEYS)[number];

const LEAVES = ["search", "page", "never", "robots", "kept"] as const;

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
      <p role="alert" className="m-0 text-ui text-rose">
        {copy.failed}
      </p>
    ) : null;
  }
  const send = (next: Partial<WebSettings>) =>
    save.mutate({ limits: next.limits ?? data.limits, blockedSites: next.blockedSites ?? data.blockedSites });
  return (
    <>
      <LimitsGroup limits={data.limits} onSave={(limits) => send({ limits })} saved={save.isSuccess} />
      <BlockedGroup
        sites={data.blockedSites}
        pending={save.isPending}
        onChange={(blockedSites) => send({ blockedSites })}
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

/** The three limits, each saved when you leave its field or press Enter, with Reset to the defaults. */
function LimitsGroup({
  limits,
  onSave,
  saved,
}: {
  limits: WebLimits;
  onSave: (limits: WebLimits) => void;
  saved: boolean;
}) {
  const id = useId();
  const [typed, setTyped] = useState<Partial<Record<LimitKey, string>>>({});
  const shown = (key: LimitKey) => typed[key] ?? String(limits[key]);
  const commit = (key: LimitKey) => {
    const value = limitOf(shown(key));
    if (value === null || value === limits[key]) return;
    onSave({ ...limits, [key]: value });
    setTyped((old) => ({ ...old, [key]: undefined }));
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
                onBlur={() => commit(key)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commit(key);
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
          <Button variant="quiet" size="xs" onClick={() => onSave(DEFAULT_WEB_LIMITS)}>
            {copy.reset}
          </Button>
        )}
        {saved && (
          <span role="status" className="ms-1 text-mint">
            {copy.saved}
          </span>
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
  onChange: (sites: ReadonlyArray<string>) => void;
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
                onClick={() => !pending && onChange(sites.filter((each) => each !== blocked))}
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
          if (!sites.includes(trimmed)) onChange([...sites, trimmed]);
          setSite("");
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
          {copy.block}
        </Button>
      </form>
      <p className="m-0 text-detail text-text-secondary">{copy.blockedNote}</p>
    </SettingsGroup>
  );
}

/** What leaves your computer when a hob searches or reads a page, and what stays. */
function LeavesGroup() {
  return (
    <SettingsGroup label={copy.leaves}>
      <dl className="m-0 grid grid-cols-1 overflow-hidden rounded-card bg-card sm:grid-cols-[minmax(140px,auto)_1fr]">
        {LEAVES.map((key) => (
          <Fragment key={key}>
            <dt className="border-line px-4 pt-3 font-bold text-text-strong sm:border-t sm:py-3 sm:first-of-type:border-t-0">
              {copy.leave[key].label}
            </dt>
            <dd className="m-0 border-line px-4 pb-3 text-ui text-text sm:border-t sm:py-3 sm:[&:nth-of-type(1)]:border-t-0">
              {copy.leave[key].text}
            </dd>
          </Fragment>
        ))}
      </dl>
    </SettingsGroup>
  );
}

/** The pages the hub holds for 15 minutes, with Clear now. */
function CacheGroup() {
  const cache = useQuery(pageCacheQuery);
  const clear = useClearPageCache();
  const held = cache.data;
  return (
    <SettingsGroup label={copy.cache}>
      <div className="flex items-center gap-3 rounded-control bg-card px-3.5 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-text-strong">
            {held === undefined ? "…" : copy.cacheHeld({ count: held.pages, bytes: held.bytes })}
          </span>
          <span className="text-detail text-text-secondary">{copy.cacheNote}</span>
        </span>
        <Button
          variant="outline"
          disabled={held === undefined || held.pages === 0}
          aria-disabled={clear.isPending}
          onClick={() => !clear.isPending && clear.mutate()}
        >
          {clear.isPending ? copy.clearing : copy.clear}
        </Button>
      </div>
      {clear.isError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {copy.clearFailed}
        </p>
      )}
    </SettingsGroup>
  );
}

import { HOB_COLORS } from "@hobbots/art/look";
import { type Agent, type AgentId, GOOD_AT_MAX, type RetireWork, starterRole } from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@hobbots/ui/components/dialog";
import { Skeleton } from "@hobbots/ui/components/skeleton";
import { Switch } from "@hobbots/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@hobbots/ui/components/tabs";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { useActivity } from "../../api/activity.ts";
import { ApiError } from "../../api/client.ts";
import { settleBrain } from "../../api/first-hob.ts";
import {
  changeCount,
  draftProblem,
  INSTRUCTIONS_MAX,
  type ProfileDraft,
  pickRole,
  profileDraft,
  profileEdit,
  RETIRE_OPTIONS,
  rebaseDraft,
  retiredSummary,
  type Summoner,
  summonerOf,
} from "../../api/profile.ts";
import {
  agentsQuery,
  archivedAgentsQuery,
  modelsQuery,
  runtimesQuery,
  threadsQuery,
  usePauseHob,
  useRetireHob,
  useUpdateHob,
} from "../../api/queries.ts";
import { formatMonthDay } from "../../lib/format.ts";
import { type HobState, hobState } from "../../lib/hob-state.ts";
import { ExportDialog } from "../export/export-dialog.tsx";
import { messages as exportCopy } from "../export/messages.ts";
import { ModelsBrain, ModelsWaiting } from "../hob-form/hob-form.tsx";
import { stateTag } from "../hob-page/hob-page-model.ts";
import { HobSkillsManage } from "../hob-skills/profile-skills.tsx";
import { HobSprite } from "../hob-sprite/hob-sprite.tsx";
import { messages } from "../messages.ts";
import { ProviderChoices } from "../providers/provider-choices.tsx";
import { RoleSheet } from "../roles/role-sheet.tsx";
import { RoleSigil } from "../roles/role-sigil.tsx";
import { CharmsTab } from "./hob-charms.tsx";
import { NameAndLook } from "./hob-name-look.tsx";
import { PermissionsTab } from "./hob-permissions.tsx";
import { TonePicker } from "./tone-picker.tsx";

/** The profile's tabs; a link may open one other than Profile with `?tab=`. */
export const ProfileTabName = Schema.Literals(["profile", "charms", "skills", "permissions"]);
type Tab = typeof ProfileTabName.Type;
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["profile", "Profile"],
  ["charms", "Charms"],
  ["skills", "Skills"],
  ["permissions", "Permissions"],
];

/**
 * A hob's profile (screen 11): who it is, how it talks and how it thinks, what it can do and what it may touch. Role,
 * tone, instructions and brain are edited together and saved as the hob's next configuration version; Charms lists its
 * tools; Permissions saves each change to its folders and rules at once. Pause / Wake and Retire act at once.
 */
export function HobProfile({ hobId, tab = "profile" }: { hobId: AgentId; tab?: Tab }) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  // A retired hob leaves the hob list, often before the retire request itself answers, so the
  // profile keeps the hob from the moment Retire is pressed to say goodbye.
  const [leaving, setLeaving] = useState<Agent | null>(null);
  const [retired, setRetired] = useState<Retired | null>(null);
  const current = hob.data ?? retired?.hob ?? leaving;

  if (!current && hob.isPending) return <ProfileWaiting hobId={hobId} />;
  if (!current) {
    return (
      <main className="grid flex-1 place-items-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="font-heading text-heading font-bold text-moonlight">{messages.profile.missing}</span>
          <span className="text-text-secondary">{messages.profile.missingNote}</span>
          <div className="flex gap-2.5">
            <Button asChild variant="outline">
              <Link to="/archive" search={{ tab: "hobs" }}>
                {messages.profile.retire.archived}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/">{messages.profile.retire.home}</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }
  return <Profile hob={current} opened={tab} retired={retired} onRetiring={setLeaving} onRetired={setRetired} />;
}

/**
 * The profile while the hob list is read for the first time (Patterns › Loading): the header in its
 * place, with a tile and line blocks for the hob's look, name and role, and the tabs. Coming from
 * the sidebar or a hob's page, the list is already there and the real header shows at once.
 */
function ProfileWaiting({ hobId }: { hobId: AgentId }) {
  return (
    <main aria-busy="true" className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4.5 px-10 pt-7 pb-6">
        <header className="flex flex-wrap items-end gap-4 rounded-card bg-card px-5 pt-5 pb-6">
          <span className="flex size-22 flex-none items-end justify-center">
            <Skeleton shape="tile" surface="card" className="size-14" />
          </span>
          <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
            <span className="font-heading text-heading">
              <Skeleton surface="card" width="8ch" />
            </span>
            <span className="text-ui">
              <Skeleton surface="card" width="24ch" />
            </span>
          </span>
          <span className="flex flex-none items-center gap-2">
            <Button asChild>
              <Link to="/hobs/$hobId/new" params={{ hobId }}>
                {messages.profile.openChat}
              </Link>
            </Button>
            <Skeleton shape="control" surface="card" className="h-[38px] w-[46px]" />
          </span>
        </header>
        <Tabs value="profile">
          <ProfileTabs disabled />
        </Tabs>
      </div>
    </main>
  );
}

/** The profile's tabs, disabled while the hob list is read. */
const ProfileTabs = ({ disabled }: { disabled: boolean }) => (
  <TabsList aria-label={messages.profile.tabs}>
    {TABS.map(([id, label]) => (
      <TabsTrigger key={id} value={id} disabled={disabled} className="px-[18px]">
        {label}
      </TabsTrigger>
    ))}
  </TabsList>
);

/** A hob the profile retired, with the choice made and whether it had replies running. */
interface Retired {
  readonly hob: Agent;
  readonly work: RetireWork;
  readonly busy: boolean;
}

function Profile({
  hob,
  opened,
  retired,
  onRetiring,
  onRetired,
}: {
  hob: Agent;
  /** The tab it opens on. */
  opened: Tab;
  retired: Retired | null;
  onRetiring: (hob: Agent) => void;
  onRetired: (retired: Retired) => void;
}) {
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const state = hobState(hob, threads.data, activity);
  const running = (threads.data ?? []).filter((t) => activity[t.id] !== undefined);
  const [tab, setTab] = useState<Tab>(opened);
  const [retireOpen, setRetireOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [hops, setHops] = useState(0);

  return (
    <main
      aria-label={messages.profile.landmark({ name: hob.name })}
      className="relative flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4.5 px-10 pt-7 pb-6">
        <ProfileHero
          hob={hob}
          state={state}
          hops={hops}
          disabled={retired !== null}
          onExport={() => setExportOpen(true)}
        />
        <Tabs
          value={tab}
          onValueChange={(next) => {
            const found = TABS.find(([id]) => id === next);
            if (found) setTab(found[0]);
          }}
          className="flex flex-col gap-4.5"
        >
          <ProfileTabs disabled={false} />
          {/* Kept mounted, so looking at another tab never drops unsaved edits. */}
          <TabsContent value="profile" forceMount className="data-[state=inactive]:hidden">
            <ProfileTab
              hob={hob}
              rest={
                <TakeABreak
                  hob={hob}
                  disabled={retired !== null}
                  onWoke={() => setHops((n) => n + 1)}
                  onRetire={() => setRetireOpen(true)}
                />
              }
            />
          </TabsContent>
          <TabsContent value="charms">
            <CharmsTab hob={hob} />
          </TabsContent>
          <TabsContent value="skills">
            <HobSkillsManage hob={hob} />
          </TabsContent>
          <TabsContent value="permissions">
            <PermissionsTab hob={hob} />
          </TabsContent>
        </Tabs>
      </div>

      {exportOpen && <ExportDialog target={{ hob }} onClose={() => setExportOpen(false)} />}
      {(retireOpen || retired) && (
        <RetireDialog
          hob={hob}
          running={running.map((t) => t.title)}
          retired={retired}
          onRetiring={onRetiring}
          onRetired={onRetired}
          onClose={() => setRetireOpen(false)}
        />
      )}
    </main>
  );
}

/**
 * The top of the profile: the hob in its hat color, its name, role and state tag, then Open chat
 * and the menu of actions kept out of the way.
 */
function ProfileHero({
  hob,
  state,
  hops,
  disabled,
  onExport,
}: {
  hob: Agent;
  state: HobState;
  hops: number;
  disabled: boolean;
  onExport: () => void;
}) {
  const tag = stateTag(state);
  const good = hob.goodAt;
  return (
    <header
      className="flex flex-wrap items-end gap-4 rounded-card px-5 pt-5 pb-6"
      style={
        {
          "--hob": HOB_COLORS[hob.lookColor].hat,
          backgroundImage:
            "linear-gradient(180deg, color-mix(in srgb, var(--hob) 26%, var(--color-card)) 0%, var(--color-card) 85%)",
          boxShadow: "inset 0 -8px 0 color-mix(in srgb, var(--hob) 45%, var(--color-deep))",
        } as CSSProperties
      }
    >
      <span className="hop-on-hover grid size-22 flex-none place-items-end-center">
        <span key={hops} className={cn("block", hops > 0 && "animate-(--hop)")}>
          <HobSprite hob={hob} size={56} state={state} badge />
        </span>
      </span>
      <span className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
        <h1 className="m-0 truncate font-heading text-heading font-bold">{hob.name}</h1>
        <span className="flex min-w-0 items-center gap-2 text-ui text-text-secondary">
          <span className="flex-none">{hob.roleTitle}</span>
          <Badge variant={tag.variant}>
            <span aria-hidden data-slot="badge-glyph">
              {tag.glyph}
            </span>
            {tag.word}
          </Badge>
          {good && <span className="truncate">{good}</span>}
        </span>
      </span>
      <span className="flex flex-none items-center gap-2">
        <Button asChild>
          <Link to="/hobs/$hobId/new" params={{ hobId: hob.id }}>
            {messages.profile.openChat}
          </Link>
        </Button>
        <MoreActions name={hob.name} disabled={disabled} onExport={onExport} />
      </span>
    </header>
  );
}

/**
 * Where the hob works, who summoned it and when, and its version. A summoner that is not among the
 * live hobs is looked for among the retired ones, read only then; until that read answers the line
 * names no summoner, and if it fails it says so with Try again.
 */
function AboutLine({ hob }: { hob: Agent }) {
  const copy = messages.profile.about;
  const live = useQuery(agentsQuery);
  const summoner = hob.summonedBy;
  const missing = summoner !== null && live.data?.some((other) => other.id === summoner) === false;
  const retired = useQuery({ ...archivedAgentsQuery, enabled: missing });
  const complete = live.isSuccess && (!missing || retired.isSuccess);
  const failed = live.isError || (missing && retired.isError);
  const by = summonerOf(hob, [...(live.data ?? []), ...(retired.data ?? [])], complete);
  const line = copy.line({
    summoned: summonedLine(by, formatMonthDay(new Date(hob.createdAt))),
    version: hob.configVersion,
  });
  if (!failed) return <p className="m-0 text-meta text-label">{line}</p>;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-label">
      <span>{line}</span>
      <span role="alert">{copy.failed}</span>
      {/* Not a submit button: the line sits inside the profile's form, and retrying must never save it. */}
      <Button
        type="button"
        variant="chip"
        size="xs"
        onClick={() => void (live.isError ? live.refetch() : retired.refetch())}
      >
        {copy.retry}
      </Button>
    </p>
  );
}

const summonedLine = (by: Summoner, date: string): string => {
  const copy = messages.profile.about;
  switch (by.kind) {
    case "you":
      return copy.byYou({ date });
    case "hob":
      return copy.byHob({ hob: by.name, date });
    case "gone":
      return copy.byGone({ date });
    case "unknown":
      return copy.byUnknown({ date });
  }
};

/** Pause or wake the hob, and the way to retire it. Both act at once, outside the save bar. */
function TakeABreak({
  hob,
  disabled,
  onWoke,
  onRetire,
}: {
  hob: Agent;
  disabled: boolean;
  onWoke: () => void;
  onRetire: () => void;
}) {
  const copy = messages.profile.rest;
  const pause = usePauseHob(hob.id);
  const paused = hob.status === "paused";
  const errorId = useId();
  const name = hob.name;
  return (
    <section
      aria-label={copy.heading}
      className="flex flex-col gap-2.5 rounded-card border-(length:--edge) border-line-2 p-4"
    >
      <span className="lbl text-label">{copy.heading}</span>
      <span className="flex items-center gap-3">
        <span className="flex-1 text-ui text-text-secondary">
          {paused ? copy.pausedLine({ name }) : copy.pauseLine({ name })}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={pause.isPending || disabled}
          aria-describedby={pause.isError ? errorId : undefined}
          onClick={() => pause.mutate(!paused, { onSuccess: onWoke })}
        >
          {paused ? copy.wake({ name }) : copy.pause({ name })}
        </Button>
      </span>
      {pause.isError && (
        <span id={errorId} role="alert" className="text-detail text-rose">
          {copy.pauseFailed({ name, paused })}
        </span>
      )}
      <span className="flex items-center gap-3 border-t border-line pt-2">
        <span className="flex-1 text-ui text-text-secondary">{copy.retireLine({ name })}</span>
        <Button type="button" variant="deny" disabled={disabled} onClick={onRetire}>
          {copy.retire({ name })}
        </Button>
      </span>
    </section>
  );
}

/**
 * The hob's name and look, role and instructions, tone and brain on one page, saved together as
 * one new configuration version from the bar that floats at the bottom while anything is unsaved.
 */
function ProfileTab({ hob, rest }: { hob: Agent; rest: React.ReactNode }) {
  const models = useQuery(modelsQuery(hob.runtime));
  const update = useUpdateHob(hob.id);
  const [base, setBase] = useState(() => profileDraft(hob, models.data));
  const [draft, setDraft] = useState<ProfileDraft>(base);
  const [saved, setSaved] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const count = changeCount(base, draft);
  const dirty = count > 0;
  const baseRef = useRef(base);
  baseRef.current = base;
  // The draft a save sent, until that save answers.
  const sendingRef = useRef<ProfileDraft | undefined>(undefined);

  // A new version saved elsewhere, or the model list arriving, refreshes what the user left alone
  // and keeps what they edited, so saving never undoes a change made in another window.
  useEffect(() => {
    const from = baseRef.current;
    const fresh = profileDraft(hob, models.data);
    setBase(fresh);
    setDraft((d) => rebaseDraft(from, fresh, d, sendingRef.current));
  }, [hob, models.data]);

  // Another provider's models settle the model and effort once its list arrives.
  const runtimes = useQuery(runtimesQuery);
  const draftModels = useQuery(modelsQuery(draft.runtime));
  const draftReady = runtimes.data?.some((h) => h.runtime === draft.runtime && h.availability === "ready") ?? false;
  useEffect(() => {
    const list = draftModels.data;
    if (list) setDraft((d) => settleBrain(d, list));
  }, [draftModels.data]);

  const edit = profileEdit(hob, draft);
  const problem = draftProblem(draft);
  const changes = Object.keys(edit).length > 0 && problem === undefined;
  const rejected = update.error instanceof ApiError && update.error.tag === "InvalidHob" ? update.error : undefined;

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!changes || update.isPending) return;
    const sent = draft;
    sendingRef.current = sent;
    update.mutate(edit, {
      onSettled: () => {
        sendingRef.current = undefined;
      },
      onSuccess: (next) => {
        // Anything typed while the save was on its way stays, still marked unsaved.
        const fresh = profileDraft(next, models.data);
        setBase(fresh);
        setDraft((d) => rebaseDraft(sent, fresh, d));
        setSaved(next.configVersion);
      },
    });
  };

  const copy = messages.profile;
  const name = hob.name;
  const failure = rejected ? copy.rejected({ reason: rejected.message }) : update.isError ? copy.failed : undefined;

  return (
    <form onSubmit={save} className="flex flex-col gap-4.5">
      <NameAndLook draft={draft} disabled={update.isPending} onChange={setDraft} />

      <section aria-labelledby="hob-role" className={CARD}>
        <span className="flex items-center gap-2">
          <h2 id="hob-role" className="lbl m-0 flex-1 text-label">
            {copy.role}
          </h2>
          <button
            type="button"
            aria-haspopup="dialog"
            disabled={update.isPending}
            onClick={() => setSheetOpen(true)}
            className={QUIET_LINK}
          >
            {copy.changeRole}
          </button>
        </span>
        <RoleLine draft={draft} />
        <label htmlFor="hob-good-at" className="lbl pt-1 text-label">
          {copy.goodAt}
        </label>
        <input
          id="hob-good-at"
          aria-describedby="hob-good-at-note"
          value={draft.goodAt}
          maxLength={GOOD_AT_MAX}
          onChange={(e) => {
            const goodAt = e.target.value;
            setDraft((d) => ({ ...d, goodAt }));
          }}
          className="rounded-control border-(length:--edge) border-control bg-deep px-2.5 py-2 text-text-strong"
        />
        <span id="hob-good-at-note" className="text-detail text-label">
          {copy.goodAtNote({ name })}
        </span>
        <label htmlFor="hob-instructions" className="lbl pt-1 text-label">
          {copy.shouldDo({ name })}
        </label>
        <textarea
          id="hob-instructions"
          aria-describedby="hob-instructions-note"
          value={draft.instructions}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(e) => {
            const instructions = e.target.value;
            setDraft((d) => ({ ...d, instructions }));
          }}
          className="h-[160px] resize-y rounded-control border-(length:--edge) border-control bg-deep px-2.5 py-2 leading-[1.55] text-text-strong"
        />
        <span id="hob-instructions-note" className="text-detail text-label">
          {copy.shouldDoNote({ name })}
        </span>
      </section>

      <section aria-labelledby="hob-tone" className={CARD}>
        <h2 id="hob-tone" className="lbl m-0 text-label">
          {copy.talks({ name })}
        </h2>
        <fieldset disabled={update.isPending} className="m-0 flex flex-col gap-3.5 border-0 p-0">
          <TonePicker
            name={name}
            voice={draft.voice}
            length={draft.length}
            onVoice={(voice) => setDraft((d) => ({ ...d, voice }))}
            onLength={(length) => setDraft((d) => ({ ...d, length }))}
          />
        </fieldset>
        <span className="text-detail text-label">{copy.toneNote({ name })}</span>
      </section>

      <section aria-labelledby="hob-brain" className={CARD}>
        <h2 id="hob-brain" className="lbl m-0 text-label">
          {copy.thinks({ name })}
        </h2>
        <fieldset disabled={update.isPending} className="m-0 flex flex-col gap-2.5 border-0 p-0">
          {runtimes.data && (
            <ProviderChoices
              runtimes={runtimes.data}
              draft={draft}
              onChange={setDraft}
              chipClassName="px-2.5 py-[5px]"
              markClassName="size-[18px] text-meta"
            />
          )}
          <Link
            to="/settings/$section"
            params={{ section: "connections" }}
            className="self-start text-detail text-link"
          >
            {copy.connectAnother}
          </Link>
          {/* While the providers are checked, the models wait in place too. */}
          {runtimes.isPending ? (
            <ModelsWaiting runtime={draft.runtime} onRetry={() => void runtimes.refetch()} surface="card" />
          ) : (
            draftReady && <ModelsBrain models={draftModels} draft={draft} onChange={setDraft} surface="card" />
          )}
        </fieldset>
      </section>

      <Visibility
        name={name}
        visible={draft.visibleToHobs}
        disabled={update.isPending}
        onChange={(visibleToHobs) => setDraft((d) => ({ ...d, visibleToHobs }))}
      />

      {rest}

      <AboutLine hob={hob} />

      <SaveBar
        name={name}
        dirty={dirty}
        count={count}
        pending={update.isPending}
        problem={problem}
        failure={failure}
        saved={saved !== null && saved === hob.configVersion}
        canSave={changes}
        onUndo={() => {
          setDraft(base);
          update.reset();
        }}
      />

      {sheetOpen && (
        <RoleSheet
          name={name}
          value={{ role: draft.role, ownTitle: draft.roleTitle, ownSigil: draft.sigil }}
          onPick={(role) => setDraft((d) => pickRole(d, role))}
          onOwnTitle={(roleTitle) => setDraft((d) => ({ ...d, roleTitle }))}
          onOwnSigil={(sigil) => setDraft((d) => ({ ...d, sigil }))}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </form>
  );
}

// A section of the Profile tab: a card with its label on top.
const CARD = "flex flex-col gap-2.5 rounded-card bg-card p-4";
// A small text button in a card's label row, such as Change role.
const QUIET_LINK =
  "cursor-pointer rounded-control border-0 bg-transparent px-1.5 py-0.5 text-detail text-link hover:bg-hover hover:text-text-strong disabled:cursor-default disabled:opacity-50";

/** Whether other hobs see this hob, with what they see when they do. */
function Visibility({
  name,
  visible,
  disabled,
  onChange,
}: {
  name: string;
  visible: boolean;
  disabled: boolean;
  onChange: (visible: boolean) => void;
}) {
  const copy = messages.profile.visibility;
  const id = useId();
  return (
    <section aria-labelledby="hob-visibility" className={CARD}>
      <h2 id="hob-visibility" className="lbl m-0 text-label">
        {copy.heading}
      </h2>
      <span className="flex items-center gap-2.5">
        <Switch
          id={id}
          checked={visible}
          disabled={disabled}
          aria-describedby={`${id}-line`}
          onCheckedChange={onChange}
        />
        <label htmlFor={id} className="flex-1 text-ui font-semibold text-text-strong">
          {copy.label}
        </label>
      </span>
      <span id={`${id}-line`} className="text-detail text-text-secondary">
        {visible ? copy.on({ name }) : copy.off({ name })}
      </span>
    </section>
  );
}

/** The role the draft has: its sigil, title and note. */
function RoleLine({ draft }: { draft: ProfileDraft }) {
  const copy = messages.profile;
  const title = draft.roleTitle.trim();
  return (
    <span className="flex items-center gap-3">
      <span aria-hidden className="grid size-8 flex-none place-items-center rounded-control bg-deep">
        <RoleSigil sigil={draft.sigil} size={24} />
      </span>
      <span className="flex min-w-0 flex-col">
        <strong className={cn(title ? "text-text-strong" : "text-label")}>{title || copy.noTitle}</strong>
        <span className="text-detail text-text-secondary">
          {draft.role === null ? copy.ownRole : starterRole(draft.role).note}
        </span>
      </span>
    </span>
  );
}

// The save bar is the inverted surface, like the toasts: light in the dark themes and dark in the
// light ones. The theme's focus ring is chosen to show on ground, so here focus is a ground ring
// drawn inside the button in every theme.
const BAR =
  "cut sticky bottom-4 z-10 flex animate-hb-in items-center gap-3 bg-text-strong px-4 py-3 text-ground shadow-menu [--control-focus-outline:none] [--control-focus-ring:inset_0_0_0_2px_var(--color-ground)]";
// Undo and Save changes: text buttons on the inverted bar.
const BAR_ACTION =
  "cut-control cursor-pointer border-0 bg-transparent px-2 py-1 font-bold whitespace-nowrap text-ground underline underline-offset-2 hover:no-underline disabled:cursor-default disabled:no-underline disabled:opacity-50";

/**
 * Floats at the bottom of the page while anything is unsaved: how many changes, Undo and Save.
 * Once saved it says so with a check mark until the next edit.
 */
function SaveBar({
  name,
  dirty,
  count,
  pending,
  problem,
  failure,
  saved,
  canSave,
  onUndo,
}: {
  name: string;
  dirty: boolean;
  count: number;
  pending: boolean;
  problem: string | undefined;
  failure: string | undefined;
  saved: boolean;
  canSave: boolean;
  onUndo: () => void;
}) {
  const copy = messages.profile;
  if (!dirty && !pending && failure === undefined) {
    return saved ? (
      <div role="status" className={BAR}>
        <span aria-hidden className="font-bold">
          ✓
        </span>
        <span className="text-ui">{copy.savedNow({ name })}</span>
      </div>
    ) : null;
  }
  const headline = problem ?? (pending ? copy.saving : copy.notSaved({ count: Math.max(count, 1) }));
  return (
    <div role={failure ? "alert" : "status"} className={BAR}>
      {failure && (
        <span aria-hidden className="font-bold">
          !
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <strong>{headline}</strong>
        <span className={cn("text-detail", failure && "font-semibold")}>{failure ?? copy.nextReply({ name })}</span>
      </span>
      <button type="button" disabled={!dirty || pending} onClick={onUndo} className={BAR_ACTION}>
        {copy.undo}
      </button>
      <button type="submit" disabled={!canSave || pending} className={BAR_ACTION}>
        {copy.save}
      </button>
    </div>
  );
}

/**
 * The actions kept out of the way: Export, for now. The list closes on Escape, on a click outside
 * or when focus leaves it.
 */
function MoreActions({ name, disabled, onExport }: { name: string; disabled: boolean; onExport: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <Button
        ref={toggle}
        variant="outline"
        aria-label={messages.profile.moreActions({ name })}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden>•••</span>
      </Button>
      {open && (
        <div
          id={listId}
          className="absolute end-0 top-full z-10 mt-1.5 flex min-w-[180px] animate-hb-in flex-col rounded-card bg-card p-1 shadow-menu"
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onExport();
            }}
            className="cursor-pointer rounded-control border-0 bg-transparent px-3 py-2 text-start text-ui text-text-strong hover:bg-hover"
          >
            {exportCopy.menuHob}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Asks what happens to the hob's running replies, then retires it. Nothing is deleted; the hob
 * goes to Archived hobs. Once retired it says the hob is asleep, and closing goes Home.
 */
function RetireDialog({
  hob,
  running,
  retired,
  onRetiring,
  onRetired,
  onClose,
}: {
  hob: Agent;
  running: ReadonlyArray<string>;
  retired: Retired | null;
  onRetiring: (hob: Agent) => void;
  onRetired: (retired: Retired) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const retire = useRetireHob(hob.id);
  const [work, setWork] = useState<RetireWork>("finish");
  const busy = running.length > 0;
  const copy = messages.profile.retire;
  const name = hob.name;

  // Once retired the profile has nothing left to show, so closing goes Home.
  const close = () => {
    if (retired) void navigate({ to: "/" });
    else if (!retire.isPending) onClose();
  };

  const confirm = () => {
    onRetiring(hob);
    retire.mutate(work, {
      onSuccess: (next) => onRetired({ hob: next, work, busy }),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-bubble-max animate-hb-in gap-3 rounded-card border-0 bg-ground p-5 shadow-sheet"
      >
        {retired ? (
          <>
            <DialogTitle className="m-0 font-heading text-heading font-bold">{copy.done({ name })}</DialogTitle>
            <p role="status" className="m-0 text-ui text-text-secondary">
              {retiredSummary(name, retired.work, retired.busy)} {copy.find({ name })}
            </p>
            <div className="flex justify-end gap-2">
              <Button asChild variant="outline">
                <Link to="/archive" search={{ tab: "hobs" }}>
                  {copy.archived}
                </Link>
              </Button>
              <Button onClick={close}>{copy.home}</Button>
            </div>
          </>
        ) : (
          <>
            <DialogTitle className="m-0 font-heading text-heading font-bold">{copy.title({ name })}</DialogTitle>
            <span className="text-ui text-text-secondary">{busy ? copy.busy({ name }) : copy.idle({ name })}</span>
            {busy && (
              <ul className="m-0 flex list-none flex-col gap-1 rounded-control bg-deep px-3 py-2 text-ui">
                {running.map((title, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two running threads may share a title.
                  <li key={i} className="truncate">
                    {title}
                  </li>
                ))}
              </ul>
            )}
            <fieldset disabled={retire.isPending} className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="sr-only">{copy.choices({ name })}</legend>
              {RETIRE_OPTIONS.map((option) => (
                <RetireChoice
                  key={option.work}
                  checked={work === option.work}
                  title={option.title(name)}
                  note={option.note(name)}
                  onPick={() => setWork(option.work)}
                />
              ))}
            </fieldset>
            <span className="text-detail text-label">{copy.kept}</span>
            {retire.isError && (
              <span role="alert" className="text-ui text-rose">
                {copy.failed({ name })}
              </span>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close} disabled={retire.isPending}>
                {copy.keep({ name })}
              </Button>
              <Button variant="deny" onClick={confirm} disabled={retire.isPending}>
                {retire.isPending ? copy.retiring : copy.confirm({ name })}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One way to retire, as a row; the picked one is filled. */
function RetireChoice({
  checked,
  title,
  note,
  onPick,
}: {
  checked: boolean;
  title: string;
  note: string;
  onPick: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-0.5 rounded-control px-3 py-2 transition-colors duration-(--dur-fade) ease-(--ease-ui)",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring",
        checked ? "bg-line text-text-strong" : "bg-card text-text hover:bg-hover",
      )}
    >
      <input type="radio" name="retire-work" checked={checked} onChange={onPick} className="sr-only" />
      <strong className="text-ui">{title}</strong>
      <span className="text-detail text-text-secondary">{note}</span>
    </label>
  );
}

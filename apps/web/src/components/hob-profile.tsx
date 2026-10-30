import type { Agent, AgentId, RetireWork } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useActivity } from "../api/activity.ts";
import { ApiError } from "../api/client.ts";
import {
  brainLine,
  goodAt,
  INSTRUCTIONS_MAX,
  isDirty,
  type ProfileDraft,
  pickRole,
  profileDraft,
  profileEdit,
  RETIRE_OPTIONS,
  rebaseDraft,
  retiredSummary,
  roleProblem,
  summonedLine,
} from "../api/profile.ts";
import { agentsQuery, modelsQuery, threadsQuery, usePauseHob, useRetireHob, useUpdateHob } from "../api/queries.ts";
import { presetInfo, type RuleAnswer } from "../api/safety.ts";
import { setupQuery } from "../api/setup.ts";
import { hobState, stateLabel } from "../lib/hob-state.ts";
import { Brain, Choice, RolePicker } from "./hob-form.tsx";
import { HobSprite } from "./hob-sprite.tsx";

type Tab = "instructions" | "tools" | "permissions";
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["instructions", "Instructions"],
  ["tools", "Tools"],
  ["permissions", "Permissions"],
];

/**
 * A hob's profile (screen 11): who it is and how it thinks. Instructions and brain are edited
 * together and saved as the hob's next configuration version; Pause / Wake and Retire act at once.
 */
export function HobProfile({ hobId }: { hobId: AgentId }) {
  const hob = useQuery({ ...agentsQuery, select: (agents) => agents.find((a) => a.id === hobId) });
  // A retired hob leaves the hob list, often before the retire request itself answers, so the
  // profile keeps the hob from the moment Retire is pressed to say goodbye.
  const [leaving, setLeaving] = useState<Agent | null>(null);
  const [retired, setRetired] = useState<Retired | null>(null);
  const current = hob.data ?? retired?.hob ?? leaving;

  if (!current) {
    return (
      <main className="grid flex-1 place-items-center">
        {hob.isPending ? (
          <span className="text-label">Loading…</span>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="font-pixel text-[22px] font-bold text-moonlight">This hob is not here</span>
            <span className="text-secondary-text">It may have retired. Retired hobs live in Archived hobs.</span>
            <div className="flex gap-2.5">
              <Button asChild variant="outline">
                <Link to="/settings/archived">See archived hobs</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/">Go to Home</Link>
              </Button>
            </div>
          </div>
        )}
      </main>
    );
  }
  return <Profile hob={current} retired={retired} onRetiring={setLeaving} onRetired={setRetired} />;
}

/** A hob the profile retired, with the choice made and whether it had replies running. */
interface Retired {
  readonly hob: Agent;
  readonly work: RetireWork;
  readonly busy: boolean;
}

function Profile({
  hob,
  retired,
  onRetiring,
  onRetired,
}: {
  hob: Agent;
  retired: Retired | null;
  onRetiring: (hob: Agent) => void;
  onRetired: (retired: Retired) => void;
}) {
  const models = useQuery(modelsQuery(hob.runtime));
  const threads = useQuery(threadsQuery(hob.id));
  const activity = useActivity();
  const state = hobState(hob, threads.data, activity);
  const running = (threads.data ?? []).filter((t) => activity[t.id] !== undefined);
  const pause = usePauseHob(hob.id);
  const [tab, setTab] = useState<Tab>("instructions");
  const [retireOpen, setRetireOpen] = useState(false);
  const [hops, setHops] = useState(0);
  const paused = hob.status === "paused";
  const good = goodAt(hob);

  const togglePause = () =>
    pause.mutate(!paused, {
      onSuccess: () => setHops((n) => n + 1),
    });

  return (
    <main aria-label={`${hob.name}'s profile`} className="relative flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-5 border-b-4 border-line bg-panel px-8 pt-[22px] pb-[18px]">
        <div className="hop-on-hover bg-line p-2">
          <span key={hops} className={cn("block", hops > 0 && "animate-hb-hop")}>
            <HobSprite hob={hob} size={72} state={state} badge />
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Link to="/hobs/$hobId" params={{ hobId: hob.id }} className="text-sm text-lantern hover:text-lantern-hover">
            ← Back to chat
          </Link>
          <h1 className="m-0 truncate font-pixel text-[32px] font-bold">{hob.name}</h1>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="cut flex-none bg-line px-2 py-0.5 text-[13px] font-bold text-moonlight">
              {hob.roleTitle}
            </span>
            {good && <span className="truncate text-[13px] text-secondary-text">Good at: {good}</span>}
          </div>
          <ul aria-label="About" className="m-0 flex list-none flex-wrap gap-2 p-0">
            <li className={cn("bg-deep px-2.5 py-1 text-[13px]", paused ? "text-lantern" : "text-mint")}>
              {paused
                ? "Paused"
                : state === "idle"
                  ? "Ready"
                  : stateLabel[state][0]?.toUpperCase() + stateLabel[state].slice(1)}
            </li>
            <li className="bg-deep px-2.5 py-1 text-[13px] text-secondary-text">{summonedLine(hob.createdAt)}</li>
            <li className="bg-deep px-2.5 py-1 text-[13px] text-secondary-text">{brainLine(hob, models.data)}</li>
            <li className="bg-deep px-2.5 py-1 text-[13px] text-secondary-text">Version {hob.configVersion}</li>
          </ul>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex gap-2.5">
            <Button
              variant="outline"
              onClick={togglePause}
              disabled={pause.isPending || retired !== null}
              aria-describedby={pause.isError ? "pause-error" : undefined}
            >
              {paused ? `Wake ${hob.name}` : `Pause ${hob.name}`}
            </Button>
            <Button variant="deny" onClick={() => setRetireOpen(true)} disabled={retired !== null}>
              {retired ? "Retired" : "Retire hob"}
            </Button>
          </div>
          {pause.isError && (
            <span id="pause-error" role="alert" className="text-[13px] text-rose">
              Hobbots could not {paused ? "wake" : "pause"} {hob.name}. Try again.
            </span>
          )}
        </div>
      </header>

      <Tabs tab={tab} onTab={setTab} />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-[22px]">
        <div role="tabpanel" id="profile-panel" aria-labelledby={`profile-tab-${tab}`}>
          {/* Kept mounted, so looking at another tab never drops unsaved edits. */}
          <div hidden={tab !== "instructions"}>
            <InstructionsTab hob={hob} />
          </div>
          {tab === "tools" && <ToolsTab name={hob.name} />}
          {tab === "permissions" && <PermissionsTab name={hob.name} />}
        </div>
      </div>

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

/** The three profile tabs; arrow keys move between them, as a tab list does. */
function Tabs({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const move = (event: React.KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (!next) return;
    onTab(next[0]);
    refs.current[next[0]]?.focus();
  };
  return (
    <div role="tablist" aria-label="Profile" className="flex gap-1 border-b-2 border-line px-6">
      {TABS.map(([id, label], index) => {
        const on = tab === id;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`profile-tab-${id}`}
            aria-selected={on}
            aria-controls="profile-panel"
            tabIndex={on ? 0 : -1}
            onClick={() => onTab(id)}
            onKeyDown={(e) => move(e, index)}
            className={cn(
              "cursor-pointer border-0 bg-transparent px-[18px] py-3 font-bold focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-moonlight",
              on
                ? "text-moonlight shadow-[inset_0_-4px_0_var(--color-lantern)]"
                : "text-secondary-text hover:text-text",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Instructions and brain, saved together as one new configuration version. */
function InstructionsTab({ hob }: { hob: Agent }) {
  const models = useQuery(modelsQuery(hob.runtime));
  const update = useUpdateHob(hob.id);
  const [base, setBase] = useState(() => profileDraft(hob, models.data));
  const [draft, setDraft] = useState<ProfileDraft>(base);
  const [saved, setSaved] = useState<number | null>(null);
  const dirty = isDirty(base, draft);
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

  const edit = profileEdit(hob, draft);
  const problem = roleProblem(draft);
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

  const status = update.isPending
    ? "Saving…"
    : problem
      ? problem
      : rejected
        ? `Hobbots could not save: ${rejected.message}.`
        : update.isError
          ? "Hobbots could not save the changes. Try again."
          : dirty
            ? `Unsaved changes. ${hob.name}'s next reply uses them once saved.`
            : saved === hob.configVersion
              ? `Saved as version ${saved}. ${hob.name}'s next reply uses it.`
              : "";

  return (
    <form onSubmit={save} className="grid grid-cols-[minmax(0,1fr)_340px] gap-7">
      <div className="flex flex-col gap-2">
        <label htmlFor="hob-instructions" className="font-bold">
          Instructions
        </label>
        <span id="hob-instructions-note" className="text-sm text-secondary-text">
          Written by Hobbots from your description. Edit freely; {hob.name} reads this before every reply.
        </span>
        <textarea
          id="hob-instructions"
          aria-describedby="hob-instructions-note"
          value={draft.instructions}
          maxLength={INSTRUCTIONS_MAX}
          onChange={(e) => {
            const instructions = e.target.value;
            setDraft((d) => ({ ...d, instructions }));
          }}
          className="h-[330px] resize-y border-2 border-control bg-deep px-4 py-3.5 leading-[1.55] text-text"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!changes || update.isPending}>
            Save changes
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setDraft(base);
              update.reset();
            }}
          >
            Discard
          </Button>
          <span
            role={update.isError ? "alert" : "status"}
            className={cn("text-sm", update.isError ? "text-rose" : dirty ? "text-lantern" : "text-secondary-text")}
          >
            {status}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <RoleField name={hob.name} draft={draft} onChange={setDraft} disabled={update.isPending} />

        <fieldset disabled={update.isPending} className="m-0 flex flex-col gap-2.5 border-0 p-0">
          <legend className="lbl mb-2.5 text-moonlight">Brain</legend>
          <div className="flex flex-wrap gap-1.5">
            <Choice name="hob-provider" checked onPick={() => {}} label="Claude" className="px-2.5 py-[5px]">
              <span
                aria-hidden
                className="grid size-[18px] place-items-center bg-[#e39a74] text-xs font-bold text-ground"
              >
                C
              </span>
              Claude
            </Choice>
          </div>
          {models.isPending ? (
            <span className="py-1 text-sm text-lantern">
              Asking Claude Code for its models <span className="animate-hb-blink">•••</span>
            </span>
          ) : models.isError ? (
            <span role="alert" className="flex items-center gap-3 text-sm text-rose">
              Hobbots could not get Claude Code's models.
              <Button type="button" variant="outline" size="xs" onClick={() => void models.refetch()}>
                Try again
              </Button>
            </span>
          ) : (
            <Brain models={models.data.models} draft={draft} onChange={setDraft} />
          )}
          <span className="text-[13px] text-label">Other providers arrive later.</span>
        </fieldset>

        <section aria-label="Works on" className="flex flex-col gap-1.5">
          <span className="lbl text-moonlight">Works on</span>
          <span>The hub</span>
          <span className="text-[13px] text-secondary-text">
            {hob.name} chats on the computer running Hobbots. Sandboxes come later.
          </span>
        </section>
      </div>
    </form>
  );
}

/**
 * The hob's role, on the same picker as Summon: a starter role, or a title in the user's own words
 * with any sigil. Saved with the rest of the tab as the next configuration version.
 */
function RoleField({
  name,
  draft,
  onChange,
  disabled,
}: {
  name: string;
  draft: ProfileDraft;
  onChange: (update: (draft: ProfileDraft) => ProfileDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <RolePicker
        value={{ role: draft.role, ownTitle: draft.roleTitle, ownSigil: draft.sigil }}
        onPick={(role) => onChange((d) => pickRole(d, role))}
        onOwnTitle={(roleTitle) => onChange((d) => ({ ...d, roleTitle }))}
        onOwnSigil={(sigil) => onChange((d) => ({ ...d, sigil }))}
        legend={<legend className="lbl mb-2.5 text-moonlight">Role</legend>}
        disabled={disabled}
      />
      <span className="text-[13px] text-label">
        A role is a label. It changes how {name} looks, not what {name} may do.
      </span>
    </div>
  );
}

/** Tools are shown read-only until hobs can use apps. */
function ToolsTab({ name }: { name: string }) {
  return (
    <div className="flex max-w-[760px] flex-col gap-2.5">
      <span className="text-secondary-text">
        Apps {name} can use. {name} only sees the accounts you connect here.
      </span>
      <div className="cut flex items-center gap-3.5 border-2 border-line bg-card px-4 py-3.5">
        <span
          aria-hidden
          className="grid size-10 flex-none place-items-center bg-line font-pixel text-lg font-bold text-moonlight"
        >
          C
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-bold">Chat</span>
          <span className="text-[13px] text-secondary-text">Answers in its threads.</span>
        </div>
        <span className="text-[13px] text-mint">Always on</span>
      </div>
      <span className="text-[13px] text-label">
        Hobs only chat today. Connecting apps such as email or a web browser arrives in a later update.
      </span>
    </div>
  );
}

const ANSWER_COLOR: Readonly<Record<RuleAnswer, string>> = {
  Allow: "bg-mint",
  Ask: "bg-lantern",
  Never: "bg-rose",
};

/** Permissions are shown read-only, from the safety preset, until hobs can act. */
function PermissionsTab({ name }: { name: string }) {
  const setup = useQuery(setupQuery);
  const preset = setup.data ? presetInfo(setup.data.safetyPreset) : undefined;
  return (
    <div className="flex max-w-[860px] flex-col gap-2">
      <span className="text-secondary-text">
        What {name} may do on its own. Ask means {name} shows a permission card in chat and waits for you.
      </span>
      {preset?.rules.map(([rule, answer]) => (
        <div key={rule} className="flex items-center gap-4 border-b-2 border-line py-3">
          <span className="flex-1 font-bold">{rule}</span>
          <ul aria-label={`${rule}: ${answer}`} className="m-0 flex list-none border-2 border-control p-0">
            {(["Allow", "Ask", "Never"] as const).map((option) => (
              <li
                key={option}
                aria-hidden
                className={cn(
                  "min-w-[70px] px-3 py-1.5 text-center text-sm",
                  option === answer ? cn(ANSWER_COLOR[option], "text-ground") : "text-label",
                )}
              >
                {option}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <span className="text-[13px] text-label">
        {preset ? `From your ${preset.label} safety. ` : ""}Hobs only chat today, so these apply once they can act.
        Changing them per hob arrives with that update.
      </span>
    </div>
  );
}

/**
 * Asks what happens to the hob's running replies, then retires it. Nothing is deleted; the hob
 * goes to Archived hobs. A native modal dialog keeps focus inside it and closes on Escape.
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
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const navigate = useNavigate();
  const retire = useRetireHob(hob.id);
  const [work, setWork] = useState<RetireWork>("finish");
  const busy = running.length > 0;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

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
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      className={cn(
        "cut m-auto w-[600px] max-w-[calc(100vw-32px)] animate-hb-in border-[3px] border-rose bg-card px-[26px] py-[22px] text-text backdrop:bg-deep/80",
      )}
    >
      {retired ? (
        <div className="flex flex-col items-center gap-2.5 py-2.5 text-center">
          <div className="relative grayscale-[.6] brightness-[.8]">
            <HobSprite hob={hob} size={72} state="asleep" />
          </div>
          <h2 id={titleId} className="m-0 font-pixel text-[22px] font-bold text-moonlight">
            {hob.name} is retired
          </h2>
          <p role="status" className="m-0 max-w-[440px] text-sm text-secondary-text">
            {retiredSummary(hob.name, retired.work, retired.busy)}
          </p>
          <div className="flex gap-2.5">
            <Button asChild variant="outline">
              <Link to="/settings/archived">See archived hobs</Link>
            </Button>
            <Button variant="outline" onClick={close}>
              Go to Home
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3.5">
            <HobSprite hob={hob} size={48} />
            <div className="flex flex-col gap-0.5">
              <h2 id={titleId} className="m-0 font-pixel text-2xl font-bold text-moonlight">
                Retire {hob.name}?
              </h2>
              <span className="text-sm text-secondary-text">
                {hob.name} stops working and goes to sleep. Nothing is deleted.
              </span>
            </div>
          </div>

          {busy && (
            <div className="cut flex flex-col gap-1.5 bg-panel px-3 py-2.5 text-sm">
              <span className="lbl text-xs text-label">{hob.name} is busy right now</span>
              {running.map((title, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two running threads may share a title.
                <span key={i}>
                  <b>{title}</b> <span className="text-mint">· running</span>
                </span>
              ))}
            </div>
          )}

          <fieldset disabled={retire.isPending} className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="sr-only">What happens to {hob.name}'s work</legend>
            {RETIRE_OPTIONS.map((option) => (
              <Choice
                key={option.work}
                name="retire-work"
                checked={work === option.work}
                onPick={() => setWork(option.work)}
                className={cn(
                  "items-start gap-2.5 px-3 py-2.5",
                  work === option.work ? "border-lantern bg-line text-text" : "border-line-2",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[3px] size-3.5 flex-none border-2",
                    work === option.work ? "border-lantern bg-lantern" : "border-line-2",
                  )}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-bold">{option.title(hob.name)}</span>
                  <span className="text-[13px] text-secondary-text">{option.note(hob.name)}</span>
                </span>
              </Choice>
            ))}
            <div className="cut flex items-start gap-2.5 border-2 border-dashed border-line-2 px-3 py-2.5 text-sm">
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2 font-bold">
                  Hand {hob.name}'s work to another hob
                  <span className="bg-lantern px-1.5 text-xs text-ground">Later</span>
                </span>
                <span className="text-[13px] text-secondary-text">Arrives once hobs can delegate.</span>
              </span>
            </div>
          </fieldset>

          <span className="text-[13px] text-label">
            Kept: {hob.name}'s threads, instructions and look. Read them any time from Settings › Archived hobs.
          </span>
          {retire.isError && (
            <span role="alert" className="text-sm text-rose">
              Hobbots could not retire {hob.name}. Try again.
            </span>
          )}
          <div className="flex justify-end gap-2.5">
            <Button variant="outline" onClick={close} disabled={retire.isPending}>
              Keep {hob.name}
            </Button>
            <Button
              onClick={confirm}
              disabled={retire.isPending}
              className="bg-rose shadow-[0_4px_0_#9a4f4f] hover:bg-rose active:shadow-[0_2px_0_#9a4f4f]"
            >
              {retire.isPending ? "Retiring…" : `Retire ${hob.name}`}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

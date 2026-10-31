import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type Agent,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
  policySandbox,
} from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { ApiError } from "../api/client.ts";
import { needsSandbox, sandboxGap } from "../api/enforcement.ts";
import { permissionsQuery, useUpdatePermissions } from "../api/queries.ts";
import {
  ANSWER,
  answersWithin,
  enforcement,
  folderName,
  pickAnswer,
  presetInfo,
  RULES,
  ruleColor,
} from "../api/safety.ts";
import { watchedSetupQuery } from "../api/setup.ts";
import { NeedsSandbox } from "./enforcement.tsx";
import { messages } from "./messages.ts";
import { FolderList, LockedSwitch } from "./safety-and-folders.tsx";

/** A focus ring drawn inside the segment, which the group's border would clip. */
const focusWithin =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-3";

/**
 * The hob's permissions as the hub works them out. They change with the hob's configuration
 * version and with the setup's preset and shared folders, so all of those key the query, and the
 * setup is watched because another window may change it while the profile stays open.
 */
export const useHobPermissions = (hob: Agent) => {
  const setup = useQuery(watchedSetupQuery);
  const basis = [hob.configVersion, setup.data?.safetyPreset, ...(setup.data?.approvedFolders ?? [])];
  const permissions = useQuery({ ...permissionsQuery(hob.id, basis), enabled: setup.data !== undefined });
  const data = permissions.data;
  return {
    data,
    // Without the setup the permissions query never starts, so a failed setup read fails both.
    isError: permissions.isError || setup.isError,
    refetch: () => (setup.isError ? setup.refetch() : permissions.refetch()),
    // An answer for an older version or setup is shown while the current one is read, but a change
    // built on it could undo a newer one, so nothing can be changed until the hub answers.
    outdated: permissions.isPlaceholderData || (data !== undefined && data.configVersion < hob.configVersion),
  };
};

export function Loading({ name, failed, retry }: { name: string; failed: boolean; retry: () => void }) {
  return failed ? (
    <p role="alert" className="m-0 flex items-center gap-3 text-sm text-rose">
      Hobbots could not read what {name} may do.
      <Button variant="outline" size="xs" onClick={retry}>
        Try again
      </Button>
    </p>
  ) : (
    <span className="text-label">Loading…</span>
  );
}

/**
 * What the hob may touch (ADR 014): its folders, the sandbox, and an answer per operation. Every
 * change is saved at once as the hob's next configuration version. Answers only narrow the preset,
 * so wider ones are not offered.
 */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function PermissionsTab({ hob }: { hob: Agent }) {
  const permissions = useHobPermissions(hob);
  const update = useUpdatePermissions(hob.id);
  const data = permissions.data;
  if (!data) {
    return <Loading name={hob.name} failed={permissions.isError} retry={() => void permissions.refetch()} />;
  }
  const sending = update.isPending ? update.variables : undefined;
  const locked = update.isPending || permissions.outdated;
  const save = (payload: UpdateHobPermissionsPayload, onSaved?: () => void) =>
    update.mutate(payload, { onSuccess: () => onSaved?.() });
  const foldersError = update.variables?.ownFolders !== undefined ? update.error : null;
  const otherError = update.variables?.ownFolders === undefined ? update.error : null;

  return (
    <div className="flex max-w-[860px] flex-col gap-2">
      <span className="text-secondary-text">
        What {hob.name} may touch. Changes are saved at once and apply from {hob.name}'s next reply.
      </span>

      <h2 className="lbl m-0 pt-3 text-xs text-label">Folders</h2>
      <span className="text-[13px] text-secondary-text">
        {hob.name} works in the shared folders it can see and its own, and nowhere else on this computer.
      </span>
      <SharedFolders
        name={hob.name}
        permissions={data}
        // Built from what the hub shows rather than the stored list, so a hidden folder that is no
        // longer shared, or was stored with another spelling, never makes the next change fail.
        hidden={sending?.hiddenSharedFolders ?? data.sharedFolders.filter((folder) => !data.folders.includes(folder))}
        pending={locked}
        onChange={(hiddenSharedFolders) => save({ hiddenSharedFolders })}
      />
      <span className="pt-2 text-sm font-bold">{hob.name}'s own folders</span>
      {data.policy.ownFolders.length === 0 && sending?.ownFolders === undefined && (
        <span className="text-sm text-secondary-text">None yet. Only {hob.name} can work in a folder added here.</span>
      )}
      <FolderList
        label={`${hob.name}'s own folders`}
        folders={data.policy.ownFolders}
        saving={sending?.ownFolders}
        pending={locked}
        error={foldersError}
        onSave={(ownFolders, onSaved) => save({ ownFolders }, onSaved)}
      />

      <h2 className="lbl m-0 pt-4 text-xs text-label">Sandbox</h2>
      <SandboxSwitch name={hob.name} sandbox={data.enforcement.processSandbox} />

      <h2 className="lbl m-0 pt-4 text-xs text-label">Rules</h2>
      <span className="text-[13px] text-secondary-text">
        From your {presetInfo(data.preset).label} safety. You can make {hob.name} more careful than that. Ask means{" "}
        {hob.name} shows a permission card in chat and waits for you.
      </span>
      {RULES.map((rule) => (
        <Rule
          key={rule.operation}
          rule={rule}
          permissions={data}
          shown={sending?.overrides ? shownAnswer(data, sending.overrides, rule.operation) : undefined}
          pending={locked}
          onPick={(answer) =>
            save({ overrides: pickAnswer(data.policy.overrides, rule.operation, answer, data.preset) })
          }
        />
      ))}
      <span className="pt-1 text-[13px] text-label">
        A checked rule is decided by Hobbots, but a command {hob.name} may run could still do it another way.
      </span>
      {otherError && (
        <p role="alert" className="m-0 text-sm text-rose">
          {otherError instanceof ApiError && otherError.tag === "OverrideWidens"
            ? `That answer allows more than your ${presetInfo(data.preset).label} safety. Pick a narrower one.`
            : otherError instanceof ApiError && otherError.tag === "InvalidFolder"
              ? otherError.message
              : `Hobbots could not save ${hob.name}'s permissions. Try again in a moment.`}
        </p>
      )}
    </div>
  );
}

/** The sandbox switch, which says so when the sandbox is missing or not yet verified here, and why. */
function SandboxSwitch({ name, sandbox }: { name: string; sandbox: HobPermissions["enforcement"]["processSandbox"] }) {
  const gap = sandbox.status === "verified" ? null : sandbox.status;
  return (
    <LockedSwitch
      label={messages.enforcement.sandboxLabel}
      note={
        gap === null
          ? messages.enforcement.sandboxOn({ name })
          : messages.enforcement.sandboxMissing[gap]({ name, evidence: sandbox.evidence })
      }
      checked={gap === null}
      later="Turning it off arrives in a later update."
    />
  );
}

const shownAnswer = (
  permissions: HobPermissions,
  overrides: NonNullable<UpdateHobPermissionsPayload["overrides"]>,
  operation: PolicyOperation,
): PolicyDecision => overrides[operation] ?? PRESET_DECISIONS[permissions.preset][operation];

/** The shared folders, each shown to the hob or hidden from it. */
function SharedFolders({
  name,
  permissions,
  hidden,
  pending,
  onChange,
}: {
  name: string;
  permissions: HobPermissions;
  hidden: ReadonlyArray<string>;
  pending: boolean;
  onChange: (hidden: ReadonlyArray<string>) => void;
}) {
  if (permissions.sharedFolders.length === 0) {
    return (
      <span className="text-sm text-secondary-text">
        No shared folders yet. <Link to="/settings">Add them in Settings</Link>
      </span>
    );
  }
  return (
    <ul aria-label="Shared folders" className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 lg:grid-cols-2">
      {permissions.sharedFolders.map((folder) => {
        const shownHidden = hidden.includes(folder);
        return (
          <li
            key={folder}
            className={cn(
              "cut flex min-w-0 items-center gap-3 border-2 bg-card px-3.5 py-3",
              shownHidden ? "border-dashed border-line-2" : "border-line",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className={cn("truncate font-bold", shownHidden && "text-secondary-text")}>
                {folderName(folder)}
              </span>
              <span className="truncate text-[13px] text-secondary-text" title={folder}>
                {shownHidden ? `Hidden from ${name} · ${folder}` : `Shared · ${folder}`}
              </span>
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={pending}
              aria-label={shownHidden ? `Show ${folder} to ${name}` : `Hide ${folder} from ${name}`}
              onClick={() =>
                onChange(
                  shownHidden ? hidden.filter((f) => f !== folder) : [...hidden.filter((f) => f !== folder), folder],
                )
              }
            >
              {shownHidden ? "Show" : "Hide"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** One rule: Allow, Ask or Never, with the answers wider than the preset left out. */
function Rule({
  rule,
  permissions,
  shown,
  pending,
  onPick,
}: {
  rule: (typeof RULES)[number];
  permissions: HobPermissions;
  /** The answer on its way to the hub. */
  shown: PolicyDecision | undefined;
  pending: boolean;
  onPick: (answer: PolicyDecision) => void;
}) {
  const name = useId();
  const labelId = useId();
  const noteId = useId();
  const preset = PRESET_DECISIONS[permissions.preset][rule.operation];
  const allowed = answersWithin(preset);
  const current = shown ?? permissions.decisions[rule.operation];
  // Why the rule is blocked whatever its answer, or null when the hub can hold it.
  const gap = needsSandbox(rule.operation, permissions.enforcement) ? sandboxGap(permissions.enforcement) : null;
  const blocked = gap !== null;
  const checked =
    !blocked &&
    enforcement(rule.operation, permissions.decisions, policySandbox(permissions.enforcement)) === "checked";
  const narrowed = current !== preset;
  return (
    <div className="flex items-center gap-4 border-b-2 border-line py-3">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span id={labelId} className="font-bold">
            {rule.label}
          </span>
          {checked && <span className="border-2 border-line-2 px-1.5 text-xs text-secondary-text">Checked</span>}
          {blocked && <NeedsSandbox />}
        </span>
        <span id={noteId} className="text-[13px] text-secondary-text">
          {rule.note}
          {narrowed && ` Narrowed from ${ANSWER[preset]}.`}
          {gap !== null && ` ${messages.enforcement.ruleBlocked[gap]}`}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={noteId}
        className="flex border-2 border-control"
      >
        {(["allow", "ask", "deny"] as const).map((answer) => {
          const on = current === answer;
          const offered = allowed.includes(answer);
          return (
            <label
              key={answer}
              title={offered ? undefined : "Wider than your safety allows"}
              className={cn(
                "min-w-[70px] px-3 py-1.5 text-center text-sm",
                on ? cn(ruleColor(ANSWER[answer]), "font-bold text-ground") : "text-secondary-text",
                offered && !on && !pending ? "cursor-pointer hover:bg-hover hover:text-text" : "",
                !offered && "text-label opacity-60",
                focusWithin,
              )}
            >
              <input
                type="radio"
                name={name}
                value={answer}
                checked={on}
                disabled={!offered || pending}
                onChange={() => onPick(answer)}
                className="sr-only"
              />
              {ANSWER[answer]}
            </label>
          );
        })}
      </div>
    </div>
  );
}

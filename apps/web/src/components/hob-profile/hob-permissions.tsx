import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import {
  type Agent,
  type PolicyDecision,
  type PolicyOperation,
  PRESET_DECISIONS,
  policySandbox,
} from "@hobbots/domain";
import { Badge } from "@hobbots/ui/components/badge";
import { Button } from "@hobbots/ui/components/button";
import { SegmentedControl, SegmentedControlItem } from "@hobbots/ui/components/segmented-control";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { ApiError } from "../../api/client.ts";
import { needsSandbox, sandboxGap } from "../../api/enforcement.ts";
import { permissionsQuery, useUpdatePermissions } from "../../api/queries.ts";
import {
  ANSWER,
  answersWithin,
  enforcement,
  folderName,
  offeredAnswer,
  PERMISSION_RULES,
  pickAnswer,
  presetInfo,
  type RuleInfo,
} from "../../api/safety.ts";
import { watchedSetupQuery } from "../../api/setup.ts";
import { messages } from "../messages.ts";
import { FolderList, LockedSwitch } from "../safety/safety-and-folders.tsx";
import { EnforcementList, NeedsSandbox } from "./enforcement.tsx";

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
    <p role="alert" className="m-0 flex items-center gap-3 text-ui text-rose">
      {messages.permissions.loadFailed({ name })}
      <Button variant="outline" size="xs" onClick={retry}>
        {messages.permissions.tryAgain}
      </Button>
    </p>
  ) : (
    <span className="text-label">{messages.permissions.loading}</span>
  );
}

/** The rules Permissions lists, in groups, by operation. The GitHub Charm card sets GitHub's. */
const RULE_GROUPS: ReadonlyArray<readonly [keyof typeof messages.permissions.groups, ReadonlyArray<PolicyOperation>]> =
  [
    ["files", ["read-files", "edit-files", "delete-files"]],
    ["commands", ["run-commands", "local-git"]],
    ["internet", ["use-web"]],
    ["outside", ["outside-folders"]],
  ];

const ruleOf = (operation: PolicyOperation): RuleInfo | undefined =>
  PERMISSION_RULES.find((rule) => rule.operation === operation);

/**
 * What the hob may touch (ADR 014): an answer per operation in plain-word groups, then its folders,
 * the sandbox and signing, and how the hub holds each rule. Every change is saved at once as the
 * hob's next configuration version. Answers only narrow the preset, so wider ones are dimmed.
 */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export function PermissionsTab({ hob }: { hob: Agent }) {
  const copy = messages.permissions;
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
  const preset = presetInfo(data.preset).label;
  const careful = PERMISSION_RULES.filter(
    (rule) =>
      offeredAnswer(rule.operation, data.decisions[rule.operation]) !== PRESET_DECISIONS[data.preset][rule.operation],
  ).length;

  return (
    <div className="flex max-w-form-max flex-col gap-4">
      <div className="flex items-center gap-3 rounded-card bg-notice px-4 py-3">
        <span className="flex flex-1 flex-col">
          <span className="text-ui text-text">{copy.intro({ name: hob.name, preset })}</span>
          <span className="text-detail text-label">{copy.careful({ count: careful, preset })}</span>
        </span>
        <Link
          to="/settings/$section"
          params={{ section: "safety" }}
          className="text-detail whitespace-nowrap text-link underline"
        >
          {copy.changeSafety}
        </Link>
      </div>

      {RULE_GROUPS.map(([group, operations]) => (
        <section key={group} aria-label={copy.groups[group]} className="flex flex-col gap-0.5">
          <h2 className="lbl m-0 pb-1 text-label">{copy.groups[group]}</h2>
          {operations.flatMap((operation) => {
            const rule = ruleOf(operation);
            return rule === undefined
              ? []
              : [
                  <Rule
                    key={operation}
                    rule={rule}
                    permissions={data}
                    shown={sending?.overrides ? shownAnswer(data, sending.overrides, operation) : undefined}
                    pending={locked}
                    onPick={(answer) =>
                      save({ overrides: pickAnswer(data.policy.overrides, operation, answer, data.preset) })
                    }
                  />,
                ];
          })}
        </section>
      ))}
      {otherError && (
        <p role="alert" className="m-0 text-ui text-rose">
          {otherError instanceof ApiError && otherError.tag === "OverrideWidens"
            ? copy.widens({ preset })
            : otherError instanceof ApiError && otherError.tag === "InvalidFolder"
              ? otherError.message
              : copy.saveFailed({ name: hob.name })}
        </p>
      )}

      <section aria-label={copy.folders({ name: hob.name })} className="flex flex-col gap-1.5">
        <h2 className="lbl m-0 text-label">{copy.folders({ name: hob.name })}</h2>
        <SharedFolders
          name={hob.name}
          permissions={data}
          // Built from what the hub shows rather than the stored list, so a hidden folder that is no
          // longer shared, or was stored with another spelling, never makes the next change fail.
          hidden={sending?.hiddenSharedFolders ?? data.sharedFolders.filter((folder) => !data.folders.includes(folder))}
          pending={locked}
          onChange={(hiddenSharedFolders) => save({ hiddenSharedFolders })}
        />
        <span className="pt-2 text-ui font-bold text-text-strong">{copy.ownFolders({ name: hob.name })}</span>
        {data.policy.ownFolders.length === 0 && sending?.ownFolders === undefined && (
          <span className="text-ui text-text-secondary">{copy.noOwnFolders({ name: hob.name })}</span>
        )}
        <FolderList
          label={copy.ownFolders({ name: hob.name })}
          folders={data.policy.ownFolders}
          saving={sending?.ownFolders}
          pending={locked}
          error={foldersError}
          onSave={(ownFolders, onSaved) => save({ ownFolders }, onSaved)}
        />
        <span className="text-detail text-label">{copy.sharedNote}</span>
      </section>

      <section aria-label={copy.sandbox} className="flex flex-col gap-1">
        <h2 className="lbl m-0 text-label">{copy.sandbox}</h2>
        <div className="flex flex-col rounded-card bg-card px-4 py-1">
          <SandboxSwitch name={hob.name} sandbox={data.enforcement.processSandbox} />
          <SigningSwitch
            name={hob.name}
            checked={sending?.signCommits ?? data.policy.signCommits === true}
            pending={locked}
            onChange={(signCommits) => save({ signCommits })}
          />
        </div>
      </section>

      <details className="rounded-control bg-card px-3.5 py-2.5">
        <summary className="cursor-pointer text-ui text-text-strong">{copy.details}</summary>
        <div className="flex flex-col gap-2 pt-2">
          <p className="m-0 text-detail text-text-secondary">{copy.detailsNote({ name: hob.name })}</p>
          <h3 className="lbl m-0 pt-1 text-label">{messages.enforcement.heading}</h3>
          <span className="text-detail text-text-secondary">{messages.enforcement.intro({ name: hob.name })}</span>
          <EnforcementList enforcement={data.enforcement} />
        </div>
      </details>
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

/**
 * Whether the hob's commands may reach the user's 1Password SSH agent (ADR 014), so Git signs commits
 * as the user's config asks. Off, commits are unsigned. The agent also logs in over SSH.
 */
function SigningSwitch({
  name,
  checked,
  pending,
  onChange,
}: {
  name: string;
  checked: boolean;
  pending: boolean;
  onChange: (checked: boolean) => void;
}) {
  const labelId = useId();
  const noteId = useId();
  return (
    <div className="flex items-center gap-4 py-2.5">
      <Switch
        aria-labelledby={labelId}
        aria-describedby={noteId}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
      <div className="flex flex-1 flex-col gap-0.5">
        <span id={labelId} className="font-bold text-text-strong">
          {messages.signing.label}
        </span>
        <span id={noteId} className="text-detail text-text-secondary">
          {checked ? messages.signing.on({ name }) : messages.signing.off({ name })}
        </span>
      </div>
    </div>
  );
}

export const shownAnswer = (
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
      <span className="text-ui text-text-secondary">
        {messages.permissions.noShared}{" "}
        <Link to="/settings/$section" params={{ section: "safety" }}>
          {messages.permissions.addInSettings}
        </Link>
      </span>
    );
  }
  return (
    <ul aria-label={messages.permissions.sharedFolders} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {permissions.sharedFolders.map((folder) => {
        const shownHidden = hidden.includes(folder);
        return (
          <li
            key={folder}
            className={cn(
              "flex min-w-0 items-center gap-3 rounded-control bg-card px-3.5 py-2.5",
              shownHidden && "border-(length:--edge) border-dashed border-line-2 bg-transparent",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span
                className={cn("truncate font-mono text-code text-text-strong", shownHidden && "text-text-secondary")}
              >
                {folderName(folder)}
              </span>
              <span className="truncate text-detail text-text-secondary" title={folder}>
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

/**
 * One rule: what it covers and Allow, Ask or Never. Answers wider than the preset are dimmed, and a
 * rule made more careful than the preset says so, with a reset. On the Charm card it sits on `deep`.
 */
export function Rule({
  rule,
  permissions,
  shown,
  pending,
  onPick,
  icon,
}: {
  rule: RuleInfo;
  permissions: HobPermissions;
  /** The answer on its way to the hub. */
  shown: PolicyDecision | undefined;
  pending: boolean;
  onPick: (answer: PolicyDecision) => void;
  /** A one-character mark before the rule, as the Charm card shows. */
  icon?: string | undefined;
}) {
  const copy = messages.permissions;
  const labelId = useId();
  const noteId = useId();
  const preset = PRESET_DECISIONS[permissions.preset][rule.operation];
  const allowed = answersWithin(preset);
  const current = shown ?? offeredAnswer(rule.operation, permissions.decisions[rule.operation]);
  // Why the rule is blocked whatever its answer, or null when the hub can hold it.
  const gap = needsSandbox(rule.operation, permissions.enforcement) ? sandboxGap(permissions.enforcement) : null;
  const blocked = gap !== null;
  const checked =
    !blocked &&
    enforcement(rule.operation, permissions.decisions, policySandbox(permissions.enforcement)) === "checked";
  const narrowed = current !== preset;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-control px-3.5 py-2.5",
        icon === undefined ? "bg-card" : "bg-deep shadow-[inset_0_0_0_1px_var(--color-line)]",
      )}
    >
      {icon !== undefined && (
        <span
          aria-hidden
          className="grid size-7 flex-none place-items-center rounded-control bg-moonlight/16 text-ui font-bold text-moonlight"
        >
          {icon}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span id={labelId} className="text-text-strong">
            {rule.label}
          </span>
          {checked && <Badge variant="muted">{copy.checked}</Badge>}
          {blocked && <NeedsSandbox />}
          {narrowed && (
            <>
              <Badge variant="needs-you">{copy.moreCareful}</Badge>
              <button
                type="button"
                disabled={pending || !allowed.includes(preset)}
                onClick={() => onPick(preset)}
                className="cursor-pointer rounded-control border-0 bg-transparent px-1 text-meta text-link hover:bg-hover hover:text-text-strong disabled:cursor-default"
              >
                {copy.reset({ preset: presetInfo(permissions.preset).label, answer: ANSWER[preset] })}
              </button>
            </>
          )}
        </span>
        <span id={noteId} className="text-detail text-text-secondary">
          {rule.note}
          {gap !== null && ` ${messages.enforcement.ruleBlocked[gap]}`}
        </span>
      </div>
      <SegmentedControl
        size="sm"
        value={current}
        onValueChange={(answer: PolicyDecision) => {
          if (answer !== current) onPick(answer);
        }}
        aria-label={rule.label}
        aria-describedby={noteId}
        className="w-[210px] flex-none"
      >
        {(rule.answers ?? (["allow", "ask", "deny"] as const)).map((answer) => {
          const offered = allowed.includes(answer);
          return (
            <SegmentedControlItem
              key={answer}
              value={answer}
              disabled={!offered || pending}
              title={offered ? undefined : copy.wider}
              className="flex-1"
            >
              {ANSWER[answer]}
            </SegmentedControlItem>
          );
        })}
      </SegmentedControl>
    </div>
  );
}

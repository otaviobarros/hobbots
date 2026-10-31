import type { HobPermissions, UpdateHobPermissionsPayload } from "@hobbots/api";
import { type Agent, type PolicyDecision, type PolicyOperation, PRESET_DECISIONS } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { ApiError } from "../api/client.ts";
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
import { setupQuery } from "../api/setup.ts";
import { FolderList, LockedSwitch } from "./safety-and-folders.tsx";

/** A focus ring drawn inside the segment, which the group's border would clip. */
const focusWithin =
  "has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-moonlight has-[:focus-visible]:-outline-offset-3";

/**
 * The hob's permissions as the hub works them out. They change with the hob's configuration
 * version and with the setup's preset and shared folders, so all of those key the query.
 */
const useHobPermissions = (hob: Agent) => {
  const setup = useQuery(setupQuery);
  const basis = [hob.configVersion, setup.data?.safetyPreset, ...(setup.data?.approvedFolders ?? [])];
  const permissions = useQuery({ ...permissionsQuery(hob.id, basis), enabled: setup.data !== undefined });
  return {
    data: permissions.data,
    // Without the setup the permissions query never starts, so a failed setup read fails both.
    isError: permissions.isError || setup.isError,
    refetch: () => (setup.isError ? setup.refetch() : permissions.refetch()),
  };
};

function Loading({ name, failed, retry }: { name: string; failed: boolean; retry: () => void }) {
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

/** The runtime's own tools, grouped as the Charms tab lists them, with the operations each covers. */
const BUILT_IN: ReadonlyArray<{
  readonly mark: string;
  readonly name: string;
  readonly note: string;
  readonly operations: ReadonlyArray<readonly [string, PolicyOperation]>;
}> = [
  {
    mark: "F",
    name: "Files",
    note: "Reads, creates, edits and deletes files in its folders.",
    operations: [
      ["Read", "read-files"],
      ["Edit", "edit-files"],
      ["Delete", "delete-files"],
    ],
  },
  {
    mark: ">",
    name: "Commands",
    note: "Runs shell commands, tests and builds.",
    operations: [["Run", "run-commands"]],
  },
  {
    mark: "G",
    name: "Local Git",
    note: "Status, diff, branches and commits, on the hub.",
    operations: [["Git", "local-git"]],
  },
  {
    mark: "W",
    name: "The web",
    note: "Fetches pages and reaches hosts from commands, such as package installs.",
    operations: [["Web", "use-web"]],
  },
];

/**
 * What the hob can do (ADR 014): its runtime's own tools with each answer and how it is held, then
 * its Charms. The answers are changed on the Permissions tab.
 */
export function CharmsTab({ hob, onPermissions }: { hob: Agent; onPermissions: () => void }) {
  const permissions = useHobPermissions(hob);
  const data = permissions.data;
  if (!data) {
    return <Loading name={hob.name} failed={permissions.isError} retry={() => void permissions.refetch()} />;
  }
  return (
    <div className="flex max-w-[760px] flex-col gap-2.5">
      <span className="text-secondary-text">
        What {hob.name} can do. Its own tools come with its runtime; Charms connect it to other apps.
      </span>

      <h2 className="lbl m-0 pt-2 text-xs text-label">Built in</h2>
      <ul aria-label="Built-in tools" className="m-0 flex list-none flex-col gap-2.5 p-0">
        {BUILT_IN.map((tool) => {
          const checked = tool.operations.filter(([, op]) => enforcement(op, data.decisions) === "checked");
          return (
            <li key={tool.name} className="cut flex items-center gap-3.5 border-2 border-line bg-card px-4 py-3.5">
              <span
                aria-hidden
                className="grid size-10 flex-none place-items-center bg-line font-pixel text-lg font-bold text-moonlight"
              >
                {tool.mark}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-bold">{tool.name}</span>
                <span className="text-[13px] text-secondary-text">{tool.note}</span>
                <span className="text-[13px] text-label">
                  {checked.length === 0
                    ? "Held by the sandbox."
                    : `${checked.map(([label]) => label).join(", ")} is checked by Hobbots, not held by the sandbox.`}
                </span>
              </div>
              <span className="flex flex-none flex-wrap justify-end gap-1.5">
                {tool.operations.map(([label, op]) => {
                  const answer = ANSWER[data.decisions[op]];
                  return (
                    <span key={op} className="flex items-center gap-1 text-[13px]">
                      {tool.operations.length > 1 && <span className="text-secondary-text">{label}</span>}
                      <span className={cn("px-2 py-0.5 text-xs font-bold text-ground", ruleColor(answer))}>
                        {answer}
                      </span>
                    </span>
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>

      <h2 className="lbl m-0 pt-2 text-xs text-label">Charms</h2>
      <div className="cut flex items-center gap-3.5 border-2 border-dashed border-line-2 px-4 py-3.5">
        <span
          aria-hidden
          className="grid size-10 flex-none place-items-center bg-line font-pixel text-lg font-bold text-moonlight"
        >
          GH
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 font-bold">
            GitHub
            <span className="bg-lantern px-1.5 text-xs font-normal text-ground">Later</span>
          </span>
          <span className="text-[13px] text-secondary-text">
            Pushes {hob.name}'s commits. You connect GitHub once on the hub, then pick which hobs may push. Push is{" "}
            {ANSWER[data.decisions.push]} for {hob.name}.
          </span>
        </div>
      </div>
      <span className="text-[13px] text-label">
        Charms connect a hob to apps such as GitHub or Slack, and each action has its own Allow, Ask or Never.
      </span>
      <div>
        <Button variant="outline" onClick={onPermissions}>
          Change what {hob.name} may do
        </Button>
      </div>
    </div>
  );
}

/**
 * What the hob may touch (ADR 014): its folders, the sandbox, and an answer per operation. Every
 * change is saved at once as the hob's next configuration version. Answers only narrow the preset,
 * so wider ones are not offered.
 */
export function PermissionsTab({ hob }: { hob: Agent }) {
  const permissions = useHobPermissions(hob);
  const update = useUpdatePermissions(hob.id);
  const data = permissions.data;
  if (!data) {
    return <Loading name={hob.name} failed={permissions.isError} retry={() => void permissions.refetch()} />;
  }
  const sending = update.isPending ? update.variables : undefined;
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
        pending={update.isPending}
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
        pending={update.isPending}
        error={foldersError}
        onSave={(ownFolders, onSaved) => save({ ownFolders }, onSaved)}
      />

      <h2 className="lbl m-0 pt-4 text-xs text-label">Sandbox</h2>
      <LockedSwitch
        label="Run in the sandbox"
        note={`Commands, Git and the web run inside Hobbots' sandbox, which keeps ${hob.name} in its folders.`}
        checked
        later="Turning it off arrives in a later update."
      />

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
          pending={update.isPending}
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
  const checked = enforcement(rule.operation, permissions.decisions) === "checked";
  const narrowed = current !== preset;
  return (
    <div className="flex items-center gap-4 border-b-2 border-line py-3">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span id={labelId} className="font-bold">
            {rule.label}
          </span>
          {checked && <span className="border-2 border-line-2 px-1.5 text-xs text-secondary-text">Checked</span>}
        </span>
        <span id={noteId} className="text-[13px] text-secondary-text">
          {rule.note}
          {narrowed && ` Narrowed from ${ANSWER[preset]}.`}
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

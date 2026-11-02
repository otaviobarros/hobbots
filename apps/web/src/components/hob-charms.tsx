import type { HobPermissions } from "@hobbots/api";
import type { Agent, PolicyOperation } from "@hobbots/domain";
import { Button } from "@hobbots/ui/components/button";
import { Switch } from "@hobbots/ui/components/switch";
import { cn } from "@hobbots/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { type ToolHolding, toolHolding } from "../api/enforcement.ts";
import { githubStatusQuery } from "../api/github.ts";
import { useUpdatePermissions } from "../api/queries.ts";
import { ANSWER, offeredAnswer, ruleColor } from "../api/safety.ts";
import { EnforcementList, NeedsSandbox } from "./enforcement.tsx";
import { Loading, useHobPermissions } from "./hob-permissions.tsx";
import { messages } from "./messages.ts";

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
        {BUILT_IN.map((tool) => (
          <BuiltInTool key={tool.name} tool={tool} permissions={data} />
        ))}
      </ul>

      <h2 className="lbl m-0 pt-2 text-xs text-label">Charms</h2>
      <GitHubCharm hob={hob} permissions={data} />
      <span className="text-[13px] text-label">
        Charms connect a hob to apps such as GitHub or Slack, and each action has its own Allow, Ask or Never. Turn one
        off and {hob.name} is offered none of its actions from its next reply.
      </span>
      <h2 className="lbl m-0 pt-2 text-xs text-label">{messages.enforcement.heading}</h2>
      <span className="text-[13px] text-secondary-text">{messages.enforcement.intro({ name: hob.name })}</span>
      <EnforcementList enforcement={data.enforcement} />
      <div className="pt-2">
        <Button variant="outline" onClick={onPermissions}>
          Change what {hob.name} may do
        </Button>
      </div>
    </div>
  );
}

/**
 * The GitHub Charm (#317, ADR 020): it reads the repository of the hob's folders on the hub, with the
 * GitHub account connected in Settings, so it needs no sandbox and no credential reaches the hob. You
 * grant it per hob here; without the grant, or with no account connected, the hob is offered none of
 * its actions. Pushing comes later.
 */
function GitHubCharm({ hob, permissions }: { hob: Agent; permissions: HobPermissions }) {
  const copy = messages.charms.github;
  const update = useUpdatePermissions(hob.id);
  const github = useQuery(githubStatusQuery);
  const switchId = useId();
  const granted = update.isPending ? update.variables.githubCharm !== false : permissions.policy.githubCharm !== false;
  const connected = github.data === undefined || github.data._tag === "Connected" || github.data._tag === "Environment";
  const read = ANSWER[offeredAnswer("read-github", permissions.decisions["read-github"])];
  return (
    <div className="cut flex flex-col gap-2.5 border-2 border-line bg-card px-4 py-3.5">
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden
          className="grid size-10 flex-none place-items-center bg-line font-pixel text-lg font-bold text-moonlight"
        >
          GH
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <label htmlFor={switchId} className="font-bold">
            {copy.name}
          </label>
          <span className="text-[13px] text-secondary-text">{copy.reads({ name: hob.name })}</span>
        </div>
        <Switch
          id={switchId}
          aria-label={copy.grant({ name: hob.name })}
          checked={granted}
          disabled={update.isPending}
          onCheckedChange={(on) => update.mutate({ githubCharm: on })}
        />
      </div>
      {granted ? (
        <ul aria-label={copy.name} className="m-0 flex list-none flex-wrap gap-3 p-0 ps-[54px]">
          <li className="flex items-center gap-1 text-[13px]">
            <span className="text-secondary-text">{copy.read}</span>
            <span className={cn("px-2 py-0.5 text-xs font-bold text-ground", ruleColor(read))}>{read}</span>
          </li>
          <li className="flex items-center gap-1 text-[13px]">
            <span className="text-secondary-text">{copy.push}</span>
            <span className="bg-lantern px-1.5 text-xs text-ground">{copy.later}</span>
            <span className="text-label">
              {copy.pushLater({ name: hob.name, push: ANSWER[permissions.decisions.push] })}
            </span>
          </li>
        </ul>
      ) : (
        <span className="ps-[54px] text-[13px] text-label">{copy.off({ name: hob.name })}</span>
      )}
      {!connected && (
        <span className="ps-[54px] text-[13px] text-secondary-text">
          {copy.notConnected}{" "}
          <Link to="/settings" hash="charms" className="text-lantern">
            {copy.connectInSettings}
          </Link>
        </span>
      )}
      {update.isError && (
        <span role="alert" className="ps-[54px] text-[13px] text-rose">
          {copy.saveFailed}
        </span>
      )}
    </div>
  );
}

const holdingLine = (holding: ToolHolding): string => {
  switch (holding.kind) {
    case "needs-sandbox":
      return messages.enforcement.toolBlocked[holding.gap];
    case "checked":
      return messages.enforcement.toolChecked({ labels: holding.labels.join(", ") });
    case "held":
      return messages.enforcement.toolHeld;
  }
};

/** One of the runtime's own tools: what it does, how it is held here, and each answer. */
function BuiltInTool({ tool, permissions }: { tool: (typeof BUILT_IN)[number]; permissions: HobPermissions }) {
  const holding = toolHolding(tool.operations, permissions);
  return (
    <li className="cut flex items-center gap-3.5 border-2 border-line bg-card px-4 py-3.5">
      <span
        aria-hidden
        className="grid size-10 flex-none place-items-center bg-line font-pixel text-lg font-bold text-moonlight"
      >
        {tool.mark}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold">{tool.name}</span>
        <span className="text-[13px] text-secondary-text">{tool.note}</span>
        <span className="text-[13px] text-label">{holdingLine(holding)}</span>
      </div>
      <span className="flex flex-none flex-wrap justify-end gap-1.5">
        {holding.kind === "needs-sandbox" ? (
          <NeedsSandbox />
        ) : (
          tool.operations.map(([label, op]) => {
            const answer = ANSWER[permissions.decisions[op]];
            return (
              <span key={op} className="flex items-center gap-1 text-[13px]">
                {tool.operations.length > 1 && <span className="text-secondary-text">{label}</span>}
                <span className={cn("px-2 py-0.5 text-xs font-bold text-ground", ruleColor(answer))}>{answer}</span>
              </span>
            );
          })
        )}
      </span>
    </li>
  );
}

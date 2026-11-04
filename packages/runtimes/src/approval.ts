import { sep } from "node:path";
import {
  type AskedDecision,
  askUntilDecided,
  type PromptRequest,
  type Redactor,
  type RuntimeEvent,
  refusal,
  type ToolStartedEvent,
  type TurnApprovals,
} from "@hobbots/agents";
import { type CommitIdentity, leftoverGitNote, steerGitInit } from "@hobbots/domain";
import type { PolicyContext, PolicyEngine, PolicyRequest, PolicyVerdict } from "@hobbots/permissions";
import { Effect } from "effect";
import { inSharedTemp, TEMP_HINT } from "./sandbox.ts";
import {
  commandWritesTo,
  initsRepository,
  narrowestVerdict,
  overridesCommitIdentity,
  toolLabel,
  toolRequests,
} from "./tool-calls.ts";

export const UNKNOWN_TOOL = (tool: string) => `Hobbots does not know the ${tool} tool, so it stays closed.`;

/**
 * Reports a call the policy allowed, just before it runs. With `record`, waits until the call is
 * recorded durably and answers whether it may run: a call Hobbots could not record never runs
 * (EX-004). Without it, the call is reported and runs.
 */
export const startCall = (
  record: PromptRequest["recordToolStart"],
  report: (event: RuntimeEvent) => void,
  event: ToolStartedEvent,
): Effect.Effect<boolean> =>
  record
    ? record(event).pipe(Effect.catchDefect(() => Effect.succeed(false)))
    : Effect.sync(() => {
        report(event);
        return true;
      });

/** A tool call as the runtime makes it. */
export interface ToolCall {
  /** The runtime's id for the call. */
  readonly id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** The folder the runtime reports for the call; relative paths resolve against it. */
  readonly cwd: string;
}

/** The folders a call pushes from with Git, as the hub reads its command. */
const pushesFrom = (call: ToolCall) => [
  ...new Set(
    (toolRequests(call.tool, call.input, call.cwd) ?? []).flatMap((request) =>
      request._tag === "Push" && request.cwd !== undefined ? [request.cwd] : [],
    ),
  ),
];

/** The hub tool a call's `git push` is pointed to instead, or null when none is. */
const steeredTo = (call: ToolCall, steersPush: ((cwd: string) => Effect.Effect<string | null>) | undefined) =>
  Effect.gen(function* () {
    if (steersPush === undefined) return null;
    for (const cwd of pushesFrom(call)) {
      const tool = yield* steersPush(cwd);
      if (tool !== null) return tool;
    }
    return null;
  });

/**
 * Why a `git push` command is refused when the turn offers the GitHub Charm's push for its folder (ADR 020): in any
 * preset, since the Charm pushes with the user's sign-in under the hob's policy, and Git in the
 * sandbox cannot.
 */
export const steerPush = (tool: string) =>
  `Push with the ${tool} tool instead of git push: Hobbots pushes your branch to GitHub for you, as the user and under your policy. A git push from your sandbox cannot sign in.`;

/**
 * Why a command that sets its own commit identity is refused (#700), naming the one the hub sets:
 * the hob's bot when it has its own GitHub App (ADR 022), else the user's (ADR 018).
 */
export const steerCommitIdentity = (commitAs: CommitIdentity | undefined) =>
  `Run Git without setting who commits: no -c user.*, git config user.*, --author or -C on git commit, and no GIT_AUTHOR_*, GIT_COMMITTER_*, EMAIL or GIT_CONFIG* variables, whether set, exported or unset. Hobbots sets who your commits are made as, and they are made as ${
    commitAs === undefined
      ? "the user, with the identity their Git config sets"
      : `${commitAs.name} <${commitAs.email}>`
  }, never as another hob or person.`;

/** Whether a call runs, and the verdict it runs under or why it does not. */
export type CallDecision = AskedDecision<PolicyVerdict>;

/** Decides a call under the context with the hob's live grants as they are now (PE-008). */
const decideIn = (
  engine: PolicyEngine["Service"],
  base: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
) =>
  Effect.gen(function* () {
    const context: PolicyContext = approvals ? { ...base, grants: yield* approvals.grants } : base;
    // Without the sandbox Bash is never offered. A command that reaches the hook anyway is decided
    // as a command, so it is refused with the reason (PE-005); a `git push` alone is never let through.
    const requests: ReadonlyArray<PolicyRequest> | null =
      call.tool === "Bash" && context.sandbox === "unavailable"
        ? [{ _tag: "Command", operation: "run-commands", cwd: call.cwd }]
        : toolRequests(call.tool, call.input, call.cwd);
    if (requests === null) return undefined;
    return narrowestVerdict(yield* Effect.forEach(requests, (request) => engine.decide(context, request)));
  });

/**
 * Decides a tool call: the policy's answer, and for Ask the user's (PE-003). While the user decides,
 * `report` gets ToolAwaitingApproval. An approved call is decided again under the hob's policy as
 * it is now, just before it runs (PE-008).
 */
export const decideCall = (
  engine: PolicyEngine["Service"],
  context: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
  report: (event: RuntimeEvent) => void,
  redaction?: Redactor | null,
  steersPush?: (cwd: string) => Effect.Effect<string | null>,
  initTool?: string,
  commitAs?: CommitIdentity,
): Effect.Effect<CallDecision> =>
  Effect.flatMap(steeredTo(call, steersPush), (pushTool) => {
    const steer = steeredAway(context, call, pushTool, initTool, commitAs);
    return steer !== null
      ? Effect.succeed<CallDecision>({ _tag: "Refuse", verdict: undefined, reason: steer })
      : askUntilDecided({
          call: {
            id: call.id,
            tool: call.tool,
            arguments: call.input,
            label: toolLabel(call.tool, call.input, redaction?.text),
          },
          approvals,
          decide: (access) =>
            decideIn(engine, access === null ? context : { ...context, ...access.policy }, approvals, call),
          report,
          unknown: UNKNOWN_TOOL(call.tool),
        }).pipe(Effect.map((decision) => withGitHint(withTempHint(call, decision), initTool)));
  });

/**
 * Why a call is refused before the policy decides it, pointing the hob to what works from its
 * sandbox, or null: a `git push` the GitHub Charm makes (ADR 020), a `git init`, which the hub makes
 * (ADR 014), a write in a shared temporary folder, for which the turn has its own (#578), and a
 * commit identity of the command's own, since the hub sets it (#700).
 */
const steeredAway = (
  context: PolicyContext,
  call: ToolCall,
  pushTool: string | null,
  initTool: string | undefined,
  commitAs: CommitIdentity | undefined,
): string | null => {
  if (pushTool !== null) return steerPush(pushTool);
  if (overridesCommitIdentity(call.tool, call.input, call.cwd)) return steerCommitIdentity(commitAs);
  if (initTool !== undefined && initsRepository(call.tool, call.input, call.cwd)) return steerGitInit(initTool);
  const temp = sharedTempWrites(context, call);
  return temp.length > 0 ? steerTemp(temp) : null;
};

/** Whether `path` is in one of the hob's folders, as the context names them. */
const inFolders = (context: PolicyContext, path: string) =>
  [
    ...context.sharedFolders.filter((folder) => !context.hob.hiddenSharedFolders.includes(folder)),
    ...context.hob.ownFolders,
  ].some((folder) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`));

/**
 * The places in shared temporary folders a command writes, which its sandbox keeps closed (#578).
 * A hob's own folder may lie in one, and is its own.
 */
const sharedTempWrites = (context: PolicyContext, call: ToolCall) =>
  commandWritesTo(call.tool, call.input, call.cwd, (path) => inSharedTemp(path) && !inFolders(context, path));

/** Why a command that writes in a shared temporary folder is refused, naming the turn's own. */
const steerTemp = (paths: ReadonlyArray<string>) =>
  `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} in a shared temporary folder, which your commands cannot write. ${TEMP_HINT}`;

/**
 * A refusal to write in a shared temporary folder, such as /tmp, also names the turn's own, which
 * its commands may write (#578).
 */
const withTempHint = (call: ToolCall, decision: CallDecision): CallDecision =>
  decision._tag === "Refuse" &&
  decision.verdict?.reason.code === "outside-folders" &&
  decision.verdict.targets.some(inSharedTemp) &&
  (toolRequests(call.tool, call.input, call.cwd) ?? []).some(
    (request) => request._tag === "Files" && request.operation !== "read-files",
  )
    ? { ...decision, reason: `${decision.reason} ${TEMP_HINT}` }
    : decision;

/** How macOS and Linux refuse to remove what the sandbox keeps. Read with string search, in linear time (STD-SEC-005). */
const KEPT_REFUSALS = ["Operation not permitted", "Read-only file system", "Device or resource busy"];

/**
 * `rm` or `find -delete` refusing, in a command's output, to remove a repository's config or hooks,
 * in macOS's words or Linux's. Git's own warning that it could not write the config is not one.
 */
const keptGitLine = (line: string) =>
  (line.startsWith("rm: ") || line.startsWith("find: ")) &&
  (line.includes(".git/config") || line.includes(".git/hooks")) &&
  KEPT_REFUSALS.some((refusal) => line.includes(refusal));

/**
 * What a hob is told after a command whose output shows its sandbox kept a repository's config or
 * hooks from a delete, when the turn offers `initTool` to replace what is left (#663), or undefined.
 */
export const keptGitHint = (
  tool: string,
  output: string | undefined,
  initTool: string | undefined,
): string | undefined =>
  tool === "Bash" && initTool !== undefined && output?.split("\n").some(keptGitLine)
    ? leftoverGitNote(initTool)
    : undefined;

/**
 * A refused delete that meets a repository's config or hooks also says what the hob can do instead,
 * when the turn offers `initTool` (#663).
 */
const withGitHint = (decision: CallDecision, initTool: string | undefined): CallDecision =>
  decision._tag === "Refuse" &&
  initTool !== undefined &&
  decision.verdict?.reason.code === "protected-path" &&
  decision.verdict.operation === "delete-files"
    ? { ...decision, reason: `${decision.reason} ${leftoverGitNote(initTool)}` }
    : decision;

/**
 * Decides a host a turn's processes reach that its sandbox has no rule for, under the hob's own
 * grants as they are now, which can answer the preset's Ask for it (ADR 015): true, or why not.
 */
export const grantedHosts =
  (engine: PolicyEngine["Service"], context: PolicyContext, approvals: TurnApprovals | null | undefined) =>
  (host: string): Promise<true | string> =>
    Effect.runPromise(
      (approvals?.grants ?? Effect.succeed([])).pipe(
        Effect.flatMap((grants) => engine.decide({ ...context, grants }, { _tag: "Web", host, addresses: [] })),
        Effect.tap((verdict) =>
          verdict.decision === "allow" && verdict.grantIds.length > 0
            ? (approvals?.used(verdict.grantIds) ?? Effect.void)
            : Effect.void,
        ),
        Effect.map((verdict) => (verdict.decision === "allow" ? true : refusal(verdict))),
      ),
    );

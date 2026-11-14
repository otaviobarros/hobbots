import { resolve, sep } from "node:path";
import {
  type AskedDecision,
  askUntilDecided,
  type CallWrites,
  type PromptRequest,
  type Redactor,
  type RuntimeEvent,
  refusal,
  type Takeover,
  type ToolStartedEvent,
  type TurnApprovals,
} from "@hobbots/agents";
import { type CommitsAs, leftoverGitNote, steerGh, steerGitInit } from "@hobbots/domain";
import {
  type PolicyContext,
  type PolicyEngine,
  type PolicyRequest,
  type PolicyVerdict,
  sessionReadWeb,
} from "@hobbots/permissions";
import { Effect } from "effect";
import { COMMIT_IDENTITY_RULE, SETUP_GITHUB } from "./git-config.ts";
import { inSharedTemp, TEMP_HINT } from "./sandbox.ts";
import {
  commandWritesTo,
  commitFolders,
  ghArguments,
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

/** The folders a call makes requests of `operation` from, as the hub reads its command. */
const requestsFrom = (call: ToolCall, operation: Takeover["operation"]) => [
  ...new Set(
    (toolRequests(call.tool, call.input, call.cwd) ?? []).flatMap((request) =>
      request._tag === "Push" && operation === "push" && request.cwd !== undefined ? [request.cwd] : [],
    ),
  ),
];

/**
 * The first takeover, of the Charms the hob holds, that applies to one of the call's requests, or
 * null (ADR 031). Every runtime's calls are steered here, from the Charms' declarations alone.
 */
const takenOver = (call: ToolCall, takeovers: ReadonlyArray<Takeover>): Effect.Effect<Takeover | null> =>
  Effect.gen(function* () {
    for (const takeover of takeovers) {
      for (const cwd of requestsFrom(call, takeover.operation)) {
        if (yield* takeover.appliesIn(cwd)) return takeover;
      }
    }
    return null;
  });

/** The first answer `answer` gives for one of `folders` that is not null, or null. */
const firstAnswer = (
  folders: ReadonlyArray<string>,
  answer: ((cwd: string) => Effect.Effect<string | null>) | undefined,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (answer === undefined) return null;
    for (const cwd of folders) {
      const found = yield* answer(cwd);
      if (found !== null) return found;
    }
    return null;
  });

/**
 * What the hub points a turn's calls to, or holds them for, before the policy decides them: the
 * same for every runtime, which takes it from the turn's steering and tools.
 */
export interface CallSteers {
  /** Who the turn's commits are made as (#586, #741), which a refused identity override names. */
  readonly commitsAs: CommitsAs;
  /** The built-in requests the Charms the hob holds take over, as they declare them (ADR 031). */
  readonly takeovers?: ReadonlyArray<Takeover> | undefined;
  /** The GitHub Charm tools the turn offers, which a `gh` command is pointed to (#1349). */
  readonly githubTools?: ReadonlyArray<string> | undefined;
  /** The hub tool a `git init` command is pointed to, when the turn offers it (ADR 014). */
  readonly initTool?: string | undefined;
  /** Why a `git commit` in a folder is held, when the hub holds it (#742). */
  readonly holdsCommit?: ((cwd: string) => Effect.Effect<string | null>) | undefined;
  /** Why a call's writes are refused: a path or branch you took over from a Task (#1449). */
  readonly takenByYou?: ((writes: CallWrites) => Effect.Effect<string | null>) | undefined;
}

/**
 * What a call writes, read from the call alone (#1449): the files a file tool or a patch changes or
 * deletes, the absolute paths a command line writes by redirection or names to a program that
 * writes them, the branches it pushes and the folders it commits in. Relative paths resolve against
 * the folder each request is made from.
 */
export const callWrites = (call: ToolCall): CallWrites => {
  const requests = toolRequests(call.tool, call.input, call.cwd) ?? [];
  const files = requests.flatMap((request) =>
    request._tag === "Files" && request.operation !== "read-files"
      ? request.paths.map((path) => resolve(request.cwd ?? call.cwd, path))
      : [],
  );
  return {
    paths: [...new Set([...files, ...commandWritesTo(call.tool, call.input, call.cwd, () => true)])],
    pushes: requests.flatMap((request) =>
      request._tag === "Push" ? [{ cwd: request.cwd ?? call.cwd, branch: request.branch }] : [],
    ),
    commits: commitFolders(call.tool, call.input, call.cwd),
  };
};

/** Why `steers` refuses what the call writes, or null; a call that writes nothing is not asked about. */
const takenWrites = (call: ToolCall, steers: CallSteers): Effect.Effect<string | null> => {
  if (steers.takenByYou === undefined) return Effect.succeed(null);
  const writes = callWrites(call);
  return writes.paths.length + writes.pushes.length + writes.commits.length === 0
    ? Effect.succeed(null)
    : steers.takenByYou(writes);
};

/**
 * Why a `git push` command is refused when a Charm the hob holds takes Push over for its folder, as
 * the GitHub Charm does (ADR 020, ADR 031): in any preset, since the Charm pushes with the user's
 * sign-in under the hob's policy, and Git in the sandbox cannot.
 */
export const steerPush = (takeover: Pick<Takeover, "charm" | "tool">) =>
  `Push with the ${takeover.tool} tool instead of git push: Hobbots pushes your branch to ${takeover.charm} for you, as the user and under your policy. A git push from your sandbox cannot sign in.`;

/**
 * Why a command that sets its own commit identity is refused (#700), naming the one the hub sets:
 * the hob's bot when it has its own GitHub App (ADR 022), else the user's (ADR 018), from their Git
 * config or, when it sets none, the one they gave Hobbots (#741). With neither, it says no identity
 * is set yet, and the hob tells the user in plain words where to set up GitHub (#1241).
 */
export const steerCommitIdentity = (commitsAs: CommitsAs) => {
  switch (commitsAs._tag) {
    case "Missing":
      return `${COMMIT_IDENTITY_RULE} Hobbots sets who your commits are made as, never you, and none is set yet. ${SETUP_GITHUB}`;
    case "Bot":
    case "UserGiven":
      return `${COMMIT_IDENTITY_RULE} Hobbots sets who your commits are made as, and they are made as ${commitsAs.identity.name} <${commitsAs.identity.email}>${
        commitsAs._tag === "UserGiven" ? ", the identity the user gave Hobbots" : ""
      }, never as another hob or person.`;
    case "UserConfig":
      return `${COMMIT_IDENTITY_RULE} Hobbots sets who your commits are made as, and they are made as the user, with the identity their Git config sets, never as another hob or person.`;
  }
};

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
    // The session's read-the-web mark is read for every call, so a page read earlier in the turn counts (ADR 036).
    const readWeb = yield* sessionReadWeb(approvals);
    const context: PolicyContext = approvals ? { ...base, grants: yield* approvals.grants, readWeb } : base;
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
 * it is now, just before it runs (PE-008). A call `steers` points elsewhere or holds is refused
 * with why, before the policy decides it.
 */
export const decideCall = (
  engine: PolicyEngine["Service"],
  context: PolicyContext,
  approvals: TurnApprovals | null | undefined,
  call: ToolCall,
  report: (event: RuntimeEvent) => void,
  steers: CallSteers,
  redaction?: Redactor | null,
): Effect.Effect<CallDecision> =>
  Effect.flatMap(steeredAway(context, call, steers), (steer) => {
    const { initTool } = steers;
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
 * sandbox, or null: a `git push` a Charm takes over, as the GitHub Charm does (ADR 020, ADR 031),
 * any `gh`, which cannot sign in there, to the GitHub Charm's tool for what it tried (#1349),
 * a commit identity of the command's own, since the hub sets it (#700), a commit the hub holds, as
 * a lead's of a member's open work (#742), a write to a path or branch you took over (#1449), a `git init`, which the hub makes (ADR 014), and a write
 * in a shared temporary folder, for which the turn has its own (#578).
 */
const steeredAway = (context: PolicyContext, call: ToolCall, steers: CallSteers): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const takeover = yield* takenOver(call, steers.takeovers ?? []);
    if (takeover !== null) return steerPush(takeover);
    const gh = ghArguments(call.tool, call.input, call.cwd);
    if (gh !== null) return steerGh(gh, steers.githubTools ?? []);
    if (overridesCommitIdentity(call.tool, call.input, call.cwd)) return steerCommitIdentity(steers.commitsAs);
    const held = yield* firstAnswer(commitFolders(call.tool, call.input, call.cwd), steers.holdsCommit);
    if (held !== null) return held;
    const yours = yield* takenWrites(call, steers);
    if (yours !== null) return yours;
    const { initTool } = steers;
    if (initTool !== undefined && initsRepository(call.tool, call.input, call.cwd)) return steerGitInit(initTool);
    const temp = sharedTempWrites(context, call);
    return temp.length > 0 ? steerTemp(temp) : null;
  });

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
 * grants as they are now, which can answer the preset's Ask for it (ADR 015), and the session's
 * read-the-web mark, under which a new host asks (ADR 036): true, or why not. The proxy cannot ask,
 * so an Ask refuses the connection with why.
 */
export const grantedHosts =
  (engine: PolicyEngine["Service"], context: PolicyContext, approvals: TurnApprovals | null | undefined) =>
  (host: string): Promise<true | string> =>
    Effect.runPromise(
      Effect.all([approvals?.grants ?? Effect.succeed([]), sessionReadWeb(approvals)]).pipe(
        Effect.flatMap(([grants, readWeb]) =>
          engine.decide({ ...context, grants, readWeb }, { _tag: "Web", host, addresses: [] }),
        ),
        Effect.tap((verdict) =>
          verdict.decision === "allow" && verdict.grantIds.length > 0
            ? (approvals?.used(verdict.grantIds) ?? Effect.void)
            : Effect.void,
        ),
        Effect.map((verdict) => (verdict.decision === "allow" ? true : refusal(verdict))),
      ),
    );

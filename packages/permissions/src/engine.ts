import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  AnyOperation,
  CharmId,
  type CharmOperation,
  CharmOperationId,
  charmOfOperation,
  DirectoryOperation,
  type Grant,
  GrantId,
  GrantRule,
  type HobPolicy,
  hobAnswers,
  isCharmOperation,
  MemoryOperation,
  narrowest,
  PolicyDecision,
  type PolicyLayer,
  type PolicyOperation,
  presetDecision,
  ruleEnforcement,
  type SafetyPreset,
  type SandboxState,
  SearchOperation,
  SkillOperation,
  stableJson,
} from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { HubHosts, isBlockedHost, isPrivateNetworkHost, normalizeHost, unmappedHost } from "./hosts.ts";
import { type CanonicalPath, isInside, PathResolver, type ScopeGitResources } from "./paths.ts";

/**
 * The policy engine of ADR 014: Allow, Ask or Deny for a normalized operation on a concrete
 * resource (PE-002). The effective answer is the narrowest of the preset, the hob's overrides and
 * every restriction the thread, Quest, task or delegation adds, so nothing can widen it (AG-004,
 * PE-004). Requests carry only the operation and its resource, never the model's account of it.
 */

/** Bumped whenever the rules below change meaning, so older decisions name the rules they followed. */
export const RULES_VERSION = 4;

/** Everything a decision depends on. Folders are canonical as stored; the engine resolves them again. */
export interface PolicyContext {
  readonly preset: SafetyPreset;
  /** Folders approved in setup, which every hob can work in unless it hides one. */
  readonly sharedFolders: ReadonlyArray<string>;
  readonly hob: HobPolicy;
  /** Hobbots' own data folder, never reachable even when a shared folder contains it. */
  readonly dataFolder: string;
  readonly sandbox: SandboxState;
  /** Hosts of the runtime's model API, which the runtime always needs. */
  readonly modelHosts: ReadonlyArray<string>;
  /**
   * The hub's own tailnet addresses and MagicDNS name, never reachable from a hob (ADR 021). The
   * engine adds the current ones from `HubHosts` to every decision.
   */
  readonly hubHosts?: ReadonlyArray<string>;
  /** Narrowing added by the thread, Quest, task or delegation. Each may only narrow. */
  readonly restrictions: ReadonlyArray<PolicyLayer>;
  /**
   * The operations the Charms declare (ADR 031), which `@hobbots/agents` fills from the Charms the
   * hub holds. A `Charm` request for an operation not among them is refused.
   */
  readonly charmOperations?: ReadonlyArray<CharmOperation>;
  /**
   * The live grants that can answer this call, read again for every call (PE-008): not revoked and
   * not expired. Only this hob's, since a grant never applies to another hob, and only its Always
   * grants and its This Task grants for the top Task the call is made in (ADR 018). Absent, no grant
   * answers anything.
   */
  readonly grants?: ReadonlyArray<Grant>;
  /**
   * Where the runtime keeps this session's own saved output: a command's or tool's output too large
   * to return inline, which the runtime tells the hob to read from there (Claude Code's
   * `tool-results`). The hob may read files there and run commands in it, never change them with its
   * file tools. They name the session, not the policy, so they are left out of the policy version.
   */
  readonly runtimeOutputs?: ReadonlyArray<RuntimeOutput>;
  /**
   * Whether the session the call is made in has read the web (ADR 036): it searched or read a page,
   * so the text it took in stays in its context. While it holds, what could send data out asks even
   * where it would be allowed: a new host a command reaches, a push, a Charm write and a memory save
   * shared beyond the hob. A found URL, local work and Never are as they were. The hub sets it from
   * its own record of what the session read, never from the model. It names the session, not the
   * policy, so it is left out of the policy version.
   */
  readonly readWeb?: boolean;
}

/**
 * A folder of the runtime's saved output, below a root the hob's commands cannot replace (its
 * runtime folder). Everything between the two may be the hob's to write, so the folder counts only
 * when no link lies on the way from the root to it: a link there could name another session's.
 */
export interface RuntimeOutput {
  readonly root: string;
  readonly folder: string;
}

export const FileOperation = Schema.Literals(["read-files", "edit-files", "delete-files"]);
export const CommandOperation = Schema.Literals(["run-commands", "local-git"]);

/**
 * A normalized operation on its concrete resource. Relative paths resolve against `cwd`. A relative
 * `cwd` names a folder a command line moved to that could not be worked out, such as after
 * `cd "$DIR"`: it and the relative paths against it are not resolved, so they are refused.
 */
export const PolicyRequest = Schema.TaggedUnion({
  /**
   * `exact` is false when the paths were read from a command line the hub's command reader cannot
   * read fully, so the shell may expand them into other files: no grant answers those (ADR 015).
   */
  Files: {
    operation: FileOperation,
    paths: Schema.Array(Schema.String),
    cwd: Schema.String,
    exact: Schema.optionalKey(Schema.Boolean),
  },
  /**
   * `words` are the simple command's literal words when the hub's command reader can read it fully
   * (`readCommandLine`); absent or null, no rule can describe it, so no grant answers it.
   */
  Command: {
    operation: CommandOperation,
    cwd: Schema.String,
    words: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  },
  /**
   * One branch a push updates. `cwd` is the folder the push runs in; without it, or with `exact`
   * false (the command's words do not say everything the push does), no grant answers it.
   */
  Push: {
    remote: Schema.String,
    branch: Schema.String,
    force: Schema.Boolean,
    toDefaultBranch: Schema.Boolean,
    cwd: Schema.optionalKey(Schema.String),
    exact: Schema.optionalKey(Schema.Boolean),
  },
  /**
   * A host the sandbox proxy was asked to reach, with the addresses it resolved to, if known. `page`
   * is set when the hub itself reads a page there for a hob (`web_fetch`, ADR 036): the URL, and
   * whether it is found, copied from you, a search result or a page read in the session. The hub
   * connects from your network, so a private network address asks, and a URL the hob wrote asks.
   */
  Web: {
    host: Schema.String,
    addresses: Schema.Array(Schema.String),
    page: Schema.optionalKey(Schema.Struct({ url: Schema.String, found: Schema.Boolean })),
  },
  /**
   * A Charm call (ADR 031): one of `charm`'s declared operations, which the hub runs outside the
   * sandbox, so it is decided on the hob's answers for the operation. `folder`, when the call was
   * found from one, such as the repository a GitHub call works on, must be one of the hob's. `site`
   * holds the values of the site fields the operation declares, which a grant names; any other field
   * is ignored. `targets` say what the call acts on, for the approval card, and default to the site's
   * values.
   */
  Charm: {
    charm: CharmId,
    operation: CharmOperationId,
    folder: Schema.optionalKey(Schema.String),
    site: Schema.Record(Schema.String, Schema.String),
    targets: Schema.optionalKey(Schema.Array(Schema.String)),
    /** A Charm write, which the hub action pipeline marks: it can send data out, so it asks while the session has read the web. */
    sends: Schema.optionalKey(Schema.Boolean),
  },
  /**
   * A memory tool call (ADR 028), which the hub serves outside the sandbox on scopes it worked out
   * itself, so it is decided on the hob's answers alone. `scope` names the memory it reaches, for the
   * approval card. No grant answers an Ask: a rule could name nothing narrower than the tool.
   */
  Memory: {
    operation: MemoryOperation,
    scope: Schema.String,
    /** A save shared beyond the hob's own memory, with a project or everyone: it asks while the session has read the web. */
    shared: Schema.optionalKey(Schema.Boolean),
  },
  /**
   * A skill tool call (ADR 029), served on the hub over the skills library, never inside the
   * sandbox, so it is decided on the hob's answers alone. `skill` names the skill it is about, or
   * the search, for the approval card. No grant answers an Ask, as for memory.
   */
  Skills: { operation: SkillOperation, skill: Schema.String },
  /**
   * A directory call (ADR 032), `read_hob`, which the hub serves over the public cards of the hobs,
   * never inside the sandbox, so it is decided on the hob's answers alone. `hob` names the hob asked
   * for, for the approval card. No grant answers an Ask, as for memory.
   */
  Directory: { operation: DirectoryOperation, hob: Schema.String },
  /**
   * A web search the runtime runs on its provider's servers (ADR 036), such as Claude Code's
   * `WebSearch`. It reaches no host from the hub, so it is decided on the hob's answers alone, and
   * Allow or Never only: an Ask refuses it, since a search on Codex cannot pause and every runtime
   * must act the same. `query` is the search, for the step.
   */
  Search: { operation: SearchOperation, query: Schema.String },
});
export type PolicyRequest = typeof PolicyRequest.Type;

export const ReasonCode = Schema.Literals([
  /** The preset's answer for the operation. */
  "preset",
  /** The hob's own override, narrower than the preset. */
  "override",
  /** A thread, Quest, task or delegation restriction, narrower than the rest. */
  "restriction",
  "outside-folders",
  "data-folder",
  /** `.git/hooks` and `.git/config` are read-only, since Git would later run them outside the sandbox. */
  "protected-path",
  /** The runtime's saved output of the session is read-only: hobs read it, never change it. */
  "runtime-output",
  "unresolvable-path",
  "no-target",
  "needs-sandbox",
  "blocked-host",
  "invalid-host",
  "model-host",
  /** A force push or a push to the default branch always asks, once only. */
  "protected-push",
  /** A change in a folder too large to search for Git repositories asks, since it could be a hook. */
  "unsearched-folder",
  /** A standing grant for this hob answers the preset's Ask (ADR 015). */
  "grant",
  /** A Charm call for an operation no Charm the hub holds declares. */
  "undeclared-operation",
  /** A Charm operation declared once only is high risk: it always asks, once only, unless refused. */
  "once-only-operation",
  /** A page the hub reads on a private network address asks under every preset, until a grant for the host (ADR 036). */
  "private-address",
  /** A page at a URL the hob wrote itself asks under every preset, once only: it could carry your data (ADR 036). */
  "written-url",
  /** The session read the web, so what could send data out asks, even where it would be allowed (ADR 036). */
  "read-the-web",
]);
export type ReasonCode = typeof ReasonCode.Type;

export const PolicyVerdict = Schema.Struct({
  decision: PolicyDecision,
  /** The operation decided, which becomes outside-folders for a target outside the hob's folders. */
  operation: AnyOperation,
  reason: Schema.Struct({ code: ReasonCode, message: Schema.String }),
  /** The concrete resources decided: canonical paths, the host, or the remote and branch. */
  targets: Schema.Array(Schema.String),
  /** Enforced by a runtime or OS boundary, or only checked by Hobbots (ADR 014). */
  enforcement: Schema.Literals(["enforced", "checked"]),
  /** A high-risk action: approved once only, and only with the user's confirmation. */
  onceOnly: Schema.Boolean,
  /** For Ask, whether a saved rule could answer it, so This Quest and Always are offered (ADR 015). */
  grantable: Schema.Boolean,
  /** For a grantable Ask, the rules Always would save: one per folder, command or host that asked. */
  rules: Schema.Array(GrantRule),
  /** For Allow, the grants that answered the preset's Ask. */
  grantIds: Schema.Array(GrantId),
  /** Identifies the rules and the exact policy inputs the decision was made under. */
  policyVersion: Schema.String,
});
export type PolicyVerdict = typeof PolicyVerdict.Type;

/** The folders a hob can work in, canonicalized. */
export interface ResolvedScope {
  readonly folders: ReadonlyArray<string>;
  readonly dataFolder: string;
  /** The runtime's saved output of the session (`PolicyContext.runtimeOutputs`), read-only. */
  readonly runtimeOutputs?: ReadonlyArray<string>;
}

/** A path as requested and its canonical form, or null when it could not be resolved. */
export interface ResolvedTarget {
  readonly input: string;
  readonly canonical: CanonicalPath | null;
  /**
   * For a change, the canonical Git hooks folders and config files it could touch (see
   * `PathResolver.protectedGitPaths`). A directory target covers everything beneath it.
   */
  readonly protectedPaths?: ReadonlyArray<string>;
  /** For a change, whether it lies in a folder too large to search for repositories. */
  readonly unsearched?: boolean;
}

/** A request whose paths are already canonical, for the pure evaluation. */
export type ResolvedRequest =
  | {
      readonly _tag: "Files";
      readonly operation: typeof FileOperation.Type;
      readonly targets: ReadonlyArray<ResolvedTarget>;
      /** False when the paths may not be the files that change, so no rule describes them. */
      readonly exact?: boolean;
    }
  | {
      readonly _tag: "Command";
      readonly operation: typeof CommandOperation.Type;
      readonly cwd: ResolvedTarget;
      readonly words?: ReadonlyArray<string> | null;
    }
  | (Omit<Extract<PolicyRequest, { readonly _tag: "Push" }>, "cwd"> & { readonly cwd?: ResolvedTarget })
  | Extract<PolicyRequest, { readonly _tag: "Web" }>
  | (Omit<Extract<PolicyRequest, { readonly _tag: "Charm" }>, "folder"> & { readonly folder?: ResolvedTarget })
  | Extract<PolicyRequest, { readonly _tag: "Memory" }>
  | Extract<PolicyRequest, { readonly _tag: "Skills" }>
  | Extract<PolicyRequest, { readonly _tag: "Directory" }>
  | Extract<PolicyRequest, { readonly _tag: "Search" }>;

/**
 * A digest of the rules version and every policy input, so an approval binds to the exact policy.
 * Grants are left out: they are read again for every call and never pin a version (ADR 015). The
 * hub's tailnet hosts are left out too: they follow Tailscale, not the policy, and so are the
 * runtime's saved output and the read-the-web mark, which follow the session.
 */
export const policyVersion = ({ grants, hubHosts, runtimeOutputs, readWeb, ...inputs }: PolicyContext): string =>
  `r${RULES_VERSION}-${createHash("sha256").update(stableJson(inputs)).digest("hex").slice(0, 16)}`;

interface Layered {
  readonly decision: PolicyDecision;
  readonly code: "preset" | "override" | "restriction";
  /** Whether the hob's override or any restriction answers Ask or Never, which no grant answers. */
  readonly narrowed: boolean;
}

/** The narrowest answer of the preset, the hob's override and each restriction, and who gave it. */
const layered = (context: PolicyContext, operation: AnyOperation): Layered => {
  let result: Omit<Layered, "narrowed"> = {
    decision: presetDecision(context.preset, operation, context.charmOperations ?? []),
    code: "preset",
  };
  let narrowed = false;
  const consider = (decision: PolicyDecision | undefined, code: Layered["code"]) => {
    if (decision === undefined) return;
    if (decision !== "allow") narrowed = true;
    if (decision !== result.decision && narrowest(result.decision, decision) === decision) {
      result = { decision, code };
    }
  };
  consider(hobAnswers(context.hob)[operation], "override");
  for (const restriction of context.restrictions) consider(restriction[operation], "restriction");
  return { ...result, narrowed };
};

const LAYER_MESSAGES: Record<Layered["code"], string> = {
  preset: "the safety preset",
  override: "this hob's own permissions",
  restriction: "a restriction on this work",
};

const DECISION_WORDS: Record<PolicyDecision, string> = { allow: "allows", ask: "asks before", deny: "never allows" };

const OPERATION_WORDS: Record<PolicyOperation, string> = {
  "read-files": "reading files",
  "edit-files": "creating and editing files",
  "delete-files": "deleting files",
  "run-commands": "running commands",
  "local-git": "local Git work",
  push: "pushing",
  "use-web": "using the web",
  "outside-folders": "anything outside the hob's folders",
  "search-memory": "searching memory",
  "save-memory": "saving to memory",
  "search-skills": "searching skills",
  "request-skill": "asking for a skill",
  "propose-skill": "suggesting a skill",
  "skill-feedback": "reporting a skill problem",
  "read-hobs": "reading other hobs",
  "search-web": "searching the web",
};

/** The words for an operation in a reason: a built-in one's own, or the ones its Charm declares. */
const wordsOf = (context: PolicyContext, operation: AnyOperation): string =>
  isCharmOperation(operation)
    ? (context.charmOperations?.find((declared) => declared.id === operation)?.words ?? operation)
    : OPERATION_WORDS[operation];

interface Answer {
  readonly decision: PolicyDecision;
  readonly operation: AnyOperation;
  readonly code: ReasonCode;
  readonly message: string;
  /** For an Ask a grant could answer, the rule Always would save. */
  readonly rule?: GrantRule;
  /** For an Allow a grant gave, that grant. */
  readonly grantId?: GrantId;
}

/** What a grant would be for: the rule offered for this call, and which saved rules match it. */
interface Site {
  readonly rule: GrantRule;
  readonly matches: (rule: GrantRule) => boolean;
}

/** The first live grant the context gives for this operation and site. */
const matchingGrant = (context: PolicyContext, operation: AnyOperation, site: Site): Grant | undefined =>
  context.grants?.find((grant) => grant.operation === operation && site.matches(grant.rule));

/**
 * The layers' answer, and where only the preset asks, a live grant for the site (ADR 015 steps 5 to
 * 8). Without a site no rule can describe the call, so nothing is offered beyond once.
 */
const fromLayers = (context: PolicyContext, operation: AnyOperation, site?: Site | null): Answer => {
  const { decision, code, narrowed } = layered(context, operation);
  const who = LAYER_MESSAGES[code];
  const answer: Answer = {
    decision,
    operation,
    code,
    message: `${who.charAt(0).toUpperCase()}${who.slice(1)} ${DECISION_WORDS[decision]} ${wordsOf(context, operation)}.`,
  };
  if (decision !== "ask" || narrowed || !site) return answer;
  const grant = matchingGrant(context, operation, site);
  if (grant === undefined) return { ...answer, rule: site.rule };
  return {
    decision: "allow",
    operation,
    code: "grant",
    message: `Your saved rule allows ${wordsOf(context, operation)} here.`,
    grantId: grant.id,
  };
};

const deny = (operation: AnyOperation, code: ReasonCode, message: string): Answer => ({
  decision: "deny",
  operation,
  code,
  message,
});

/**
 * Places a canonical target in the hob's scope: inside a folder (and which), or why not. With
 * `outputs`, the runtime's saved output of the session counts too, for reading files and running
 * commands only: for a push or a Charm it is outside the hob's folders.
 */
const locate = (scope: ResolvedScope, target: ResolvedTarget, outputs = false): Located | Answer => {
  if (target.canonical === null) {
    return deny(
      "outside-folders",
      "unresolvable-path",
      `Hobbots could not resolve ${target.input}, so it stays closed.`,
    );
  }
  const canonical = target.canonical;
  if (isInside(canonical, scope.dataFolder)) {
    return deny(
      "outside-folders",
      "data-folder",
      `${canonical.path} is in Hobbots' own data folder, which hobs never reach.`,
    );
  }
  const folder = scope.folders.find((f) => isInside(canonical, f));
  if (folder !== undefined) return { folder, canonical };
  const output = outputs ? scope.runtimeOutputs?.find((f) => isInside(canonical, f)) : undefined;
  if (output !== undefined) return { folder: output, canonical, runtimeOutput: true };
  return deny("outside-folders", "outside-folders", `${canonical.path} is outside this hob's folders.`);
};

interface Located {
  readonly folder: string;
  readonly canonical: CanonicalPath;
  /** In the runtime's saved output of the session, which is read-only and named by no grant. */
  readonly runtimeOutput?: true;
}

const located = (value: Located | Answer): value is Located => "folder" in value;

/** Whether `other` names the same path as `target`, with the target volume's case rules. */
const samePath = (target: CanonicalPath, other: string): boolean =>
  isInside(target, other) && isInside({ path: other, caseSensitive: target.caseSensitive }, target.path);

/**
 * A file's site (ADR 015): the folder that directly holds it, or for a delete, the exact path, since
 * the target may itself be a folder and a rule must never reach the folder above it. A file whose
 * parent is outside the hob's folders is offered as the exact path too.
 */
const fileSite = (operation: typeof FileOperation.Type, place: Located): Site => {
  const { canonical } = place;
  const parent = dirname(canonical.path);
  const exact: GrantRule = { _tag: "Paths", operation, paths: [canonical.path] };
  const inPaths = (rule: GrantRule) => rule._tag === "Paths" && rule.paths.some((p) => samePath(canonical, p));
  if (operation === "delete-files" || !isInside({ ...canonical, path: parent }, place.folder)) {
    return { rule: exact, matches: inPaths };
  }
  return {
    rule: { _tag: "Folder", operation, folder: parent },
    matches: (rule) =>
      inPaths(rule) || (rule._tag === "Folder" && samePath({ ...canonical, path: parent }, rule.folder)),
  };
};

const fileTarget = (
  context: PolicyContext,
  scope: ResolvedScope,
  operation: typeof FileOperation.Type,
  target: ResolvedTarget,
  exact = true,
): Answer => {
  const place = locate(scope, target, true);
  // Every preset answers Deny outside the folders, and the narrowing layers cannot widen it.
  if (!located(place)) return place;
  if (place.runtimeOutput) {
    // A grant would name one session's folder, so nothing is offered beyond once.
    if (operation === "read-files") return fromLayers(context, operation);
    const message = `${place.canonical.path} holds output your runtime saved, which hobs can only read.`;
    return deny(operation, "runtime-output", message);
  }
  if (operation !== "read-files") {
    const { canonical } = place;
    // Changing a folder changes everything in it, so a protected path below the target counts too.
    const overlaps = (protectedPath: string) =>
      isInside(canonical, protectedPath) ||
      isInside({ path: protectedPath, caseSensitive: canonical.caseSensitive }, canonical.path);
    if (overlaps(scope.dataFolder)) {
      return deny(
        operation,
        "data-folder",
        `${canonical.path} holds Hobbots' own data folder, which hobs never reach.`,
      );
    }
    if ((target.protectedPaths ?? []).some(overlaps)) {
      return deny(
        operation,
        "protected-path",
        `${canonical.path} is or holds a Git hook or config, which hobs can only read.`,
      );
    }
    if (target.unsearched === true) {
      // A safety Ask is never answered by a grant, so no site is offered here.
      const answer = fromLayers(context, operation);
      if (answer.decision === "allow") {
        return {
          decision: "ask",
          operation,
          code: "unsearched-folder",
          message: `${canonical.path} is in a folder too large to check for Git hooks, so changing it needs approval.`,
        };
      }
      return answer;
    }
  }
  return fromLayers(context, operation, exact ? fileSite(operation, place) : null);
};

/** Picks the narrowest of several answers, keeping the first on a tie. */
const pickNarrowest = (answers: ReadonlyArray<Answer>): Answer | undefined =>
  answers.reduce<Answer | undefined>(
    (current, next) =>
      current === undefined ||
      (next.decision !== current.decision && narrowest(current.decision, next.decision) === next.decision)
        ? next
        : current,
    undefined,
  );

const needsSandbox = (context: PolicyContext, operation: PolicyOperation): Answer | null =>
  context.sandbox === "unavailable"
    ? deny(
        operation,
        "needs-sandbox",
        `The sandbox cannot start on this hub, so ${OPERATION_WORDS[operation]} is blocked.`,
      )
    : null;

/** A Charm call runs on the hub, which enforces its answer itself. */
const enforcementOf = (context: PolicyContext, operation: AnyOperation): PolicyVerdict["enforcement"] =>
  isCharmOperation(operation)
    ? "enforced"
    : ruleEnforcement(operation, (other) => layered(context, other).decision, context.sandbox);

/** The answers a request's parts gave, its targets, and whether it is high risk. */
interface Evaluated {
  readonly answers: ReadonlyArray<Answer>;
  readonly targets: ReadonlyArray<string>;
  readonly onceOnly?: boolean;
}

const sameWords = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((word, i) => word === b[i]);

/** A command's site: exactly its literal words, in exactly its folder (ADR 015). */
const commandSite = (
  operation: typeof CommandOperation.Type,
  cwd: CanonicalPath,
  words: ReadonlyArray<string> | null | undefined,
): Site | null =>
  words === null || words === undefined || words.length === 0
    ? null
    : {
        rule: { _tag: "Command", operation, cwd: cwd.path, words: [...words] },
        matches: (rule) =>
          rule._tag === "Command" &&
          rule.operation === operation &&
          samePath(cwd, rule.cwd) &&
          sameWords(rule.words, words),
      };

const evaluateFiles = (
  context: PolicyContext,
  scope: ResolvedScope,
  request: Extract<ResolvedRequest, { readonly _tag: "Files" }>,
): Evaluated => ({
  targets: request.targets.map((t) => t.canonical?.path ?? t.input),
  answers:
    request.targets.length === 0
      ? [deny(request.operation, "no-target", "The call named no file, so there is nothing to allow.")]
      : request.targets.map((t) => fileTarget(context, scope, request.operation, t, request.exact !== false)),
});

const evaluateCommand = (
  context: PolicyContext,
  scope: ResolvedScope,
  request: Extract<ResolvedRequest, { readonly _tag: "Command" }>,
): Evaluated => {
  const place = locate(scope, request.cwd, true);
  const answer = !located(place)
    ? place
    : (needsSandbox(context, request.operation) ??
      fromLayers(
        context,
        request.operation,
        place.runtimeOutput ? null : commandSite(request.operation, place.canonical, request.words),
      ));
  return { targets: [request.cwd.canonical?.path ?? request.cwd.input], answers: [answer] };
};

const evaluatePush = (
  context: PolicyContext,
  scope: ResolvedScope,
  request: Extract<ResolvedRequest, { readonly _tag: "Push" }>,
): Evaluated => {
  const targets = [`${request.remote} ${request.branch}`];
  const risky = request.force || request.toDefaultBranch;
  const place = request.cwd === undefined ? null : locate(scope, request.cwd);
  const cwd = place !== null && located(place) ? place.canonical : null;
  // A high-risk push is never granted, and a push from an unknown folder cannot name its site.
  const site: Site | null =
    risky || cwd === null || request.exact === false
      ? null
      : {
          rule: { _tag: "Push", cwd: cwd.path, remote: request.remote, branch: request.branch },
          matches: (rule) =>
            rule._tag === "Push" &&
            samePath(cwd, rule.cwd) &&
            rule.remote === request.remote &&
            rule.branch === request.branch,
        };
  const answer = fromLayers(context, "push", site);
  if (!risky || answer.decision === "deny") return { targets, answers: [answer] };
  const message = request.force
    ? "A force push always waits for you, once only."
    : "A push to the default branch always waits for you, once only.";
  return {
    targets,
    answers: [{ decision: "ask", operation: "push", code: "protected-push", message }],
    onceOnly: true,
  };
};

const evaluateWeb = (
  context: PolicyContext,
  request: Extract<ResolvedRequest, { readonly _tag: "Web" }>,
): Evaluated => {
  const host = normalizeHost(request.host);
  const targets = [host ?? request.host];
  if (host === null)
    return { targets, answers: [deny("use-web", "invalid-host", `${request.host} is not a host name or address.`)] };
  const addresses = request.addresses.map(normalizeHost);
  // The hub reads a page outside the sandbox, from your computer, and reaches these no more than it does.
  const never = request.page === undefined ? "never reachable from the sandbox" : "which Hobbots never reads pages on";
  if (isBlockedHost(host) || addresses.some((a) => a === null || isBlockedHost(a))) {
    const message = `${host} is a loopback, link-local or cloud metadata address, ${never}.`;
    return { targets, answers: [deny("use-web", "blocked-host", message)] };
  }
  // An IPv4-mapped IPv6 address reaches the IPv4 address it maps, so both compare unmapped.
  const hub = new Set((context.hubHosts ?? []).flatMap((name) => normalizeHost(name) ?? []).map(unmappedHost));
  const isHub = (name: string | null) => name !== null && hub.has(unmappedHost(name));
  if (isHub(host) || addresses.some(isHub)) {
    const message = `${host} is this hub's own address on the tailnet, ${never}.`;
    return { targets, answers: [deny("use-web", "blocked-host", message)] };
  }
  const sandbox = needsSandbox(context, "use-web");
  if (sandbox !== null) return { targets, answers: [sandbox] };
  if (context.modelHosts.map(normalizeHost).includes(host)) {
    const message = `${host} is the runtime's model API.`;
    return { targets, answers: [{ decision: "allow", operation: "use-web", code: "model-host", message }] };
  }
  const site: Site = {
    rule: { _tag: "Host", host },
    matches: (rule) => rule._tag === "Host" && normalizeHost(rule.host) === host,
  };
  const answer = fromLayers(context, "use-web", site);
  if (request.page === undefined) return { targets, answers: [answer] };
  return { targets, answers: [pageAnswer(context, answer, site, host, [host, ...addresses], request.page)] };
};

/**
 * A page the hub reads for a hob (ADR 036), past what the site rules said. Never stays Never. A URL
 * the hob wrote asks under every preset, and no grant answers it: a grant says the site is fine,
 * not that this URL is. A page on a private network address asks with Always for its host, and
 * only a saved grant for that host answers it.
 */
const pageAnswer = (
  context: PolicyContext,
  answer: Answer,
  site: Site,
  host: string,
  names: ReadonlyArray<string | null>,
  page: { readonly url: string; readonly found: boolean },
): Answer => {
  if (answer.decision === "deny") return answer;
  if (!page.found) {
    const message = `This URL was not copied from you, a search result or a page read in this session, so it waits for you: it could carry your data to ${host}.`;
    return { decision: "ask", operation: "use-web", code: "written-url", message };
  }
  if (!names.some((name) => name !== null && isPrivateNetworkHost(name)) || answer.code === "grant") return answer;
  // An Ask your own settings narrowed to stays one no grant answers.
  if (answer.decision === "ask" && answer.rule === undefined) return answer;
  const grant = matchingGrant(context, "use-web", site);
  if (grant !== undefined) {
    const message = `Your saved rule allows reading pages on ${host}.`;
    return { decision: "allow", operation: "use-web", code: "grant", message, grantId: grant.id };
  }
  const message = `${host} is on your local network, so reading it waits for you.`;
  return { decision: "ask", operation: "use-web", code: "private-address", message, rule: site.rule };
};

/**
 * A grant for a Charm call (ADR 015, ADR 031): the call's folder, when it has one, and the value of
 * every site field the operation declares. An operation that declares no site, or is once only, has
 * none, and neither has a call missing a declared field, so each is approved once only.
 */
const charmSite = (
  declared: CharmOperation,
  request: Extract<ResolvedRequest, { readonly _tag: "Charm" }>,
  cwd: CanonicalPath | null,
): Site | null => {
  if (declared.onceOnly || declared.site.length === 0) return null;
  const site: Record<string, string> = {};
  for (const field of declared.site) {
    const value = request.site[field];
    if (value === undefined) return null;
    site[field] = value;
  }
  return {
    rule: {
      _tag: "CharmSite",
      charm: request.charm,
      operation: request.operation,
      ...(cwd === null ? {} : { cwd: cwd.path }),
      site,
    },
    matches: (rule) =>
      rule._tag === "CharmSite" &&
      rule.charm === request.charm &&
      rule.operation === request.operation &&
      (cwd === null ? rule.cwd === undefined : rule.cwd !== undefined && samePath(cwd, rule.cwd)) &&
      declared.site.every((field) => rule.site[field] === site[field]),
  };
};

/**
 * A Charm call (ADR 031): an operation its Charm declares, decided like a built-in one on the
 * declared preset answers, the hob's override and every restriction. The folder it was found from,
 * if any, must be the hob's.
 */
const evaluateCharm = (
  context: PolicyContext,
  scope: ResolvedScope,
  request: Extract<ResolvedRequest, { readonly _tag: "Charm" }>,
): Evaluated => {
  const targets = request.targets ?? Object.values(request.site);
  const declared = context.charmOperations?.find((operation) => operation.id === request.operation);
  if (declared === undefined || charmOfOperation(request.operation) !== request.charm) {
    const message = `No Charm on this hub declares ${request.operation}, so it stays closed.`;
    return { targets, answers: [deny(request.operation, "undeclared-operation", message)] };
  }
  const place = request.folder === undefined ? null : locate(scope, request.folder);
  if (place !== null && !located(place)) return { targets, answers: [place] };
  const site = charmSite(declared, request, place === null ? null : place.canonical);
  const answer = fromLayers(context, request.operation, site);
  if (!declared.onceOnly || answer.decision === "deny") return { targets, answers: [answer] };
  // A high-risk operation asks even where every layer allows it (ADR 015): Never still wins.
  const message = `${declared.words.charAt(0).toUpperCase()}${declared.words.slice(1)} always waits for you, once only.`;
  return {
    targets,
    answers: [{ decision: "ask", operation: request.operation, code: "once-only-operation", message }],
    onceOnly: true,
  };
};

/**
 * An answer for an operation that takes Allow or Never only (ADR 036): an Ask, as a restriction
 * saved before could give, refuses the call, as it would on a runtime that cannot pause it.
 */
const allowOrNever = (answer: Answer): Answer =>
  answer.decision === "ask"
    ? { ...answer, decision: "deny", message: `${answer.message} It takes no Ask, so the call does not run.` }
    : answer;

const evaluateParts = (context: PolicyContext, scope: ResolvedScope, request: ResolvedRequest): Evaluated => {
  switch (request._tag) {
    case "Files":
      return evaluateFiles(context, scope, request);
    case "Command":
      return evaluateCommand(context, scope, request);
    case "Push":
      return evaluatePush(context, scope, request);
    case "Web":
      return evaluateWeb(context, request);
    case "Charm":
      return evaluateCharm(context, scope, request);
    case "Memory":
      return { targets: [request.scope], answers: [fromLayers(context, request.operation)] };
    case "Skills":
      return { targets: [request.skill], answers: [fromLayers(context, request.operation)] };
    case "Directory":
      return { targets: [request.hob], answers: [fromLayers(context, request.operation)] };
    case "Search":
      return { targets: [request.query], answers: [allowOrNever(fromLayers(context, request.operation))] };
  }
};

/** What the read-the-web mark asks for (ADR 036): each is a way the session's data could leave. */
const sendsOut = (request: ResolvedRequest): "host" | "push" | "charm" | "share" | null => {
  switch (request._tag) {
    case "Web":
      // A page the hub reads is decided by where its URL came from: a found one by the site rules.
      return request.page === undefined ? "host" : null;
    case "Push":
      return "push";
    case "Charm":
      return request.sends === true ? "charm" : null;
    case "Memory":
      return request.shared === true ? "share" : null;
    default:
      return null;
  }
};

const MARK_WORDS: Record<NonNullable<ReturnType<typeof sendsOut>>, string> = {
  host: "a command reaching a new host",
  push: "a push",
  charm: "a Charm write",
  share: "a memory save shared beyond this hob",
};

/**
 * The answer while the session has read the web (ADR 036): an Allow of what could send data out
 * asks, since a page may have told the hob to send your data. A saved Always for a command's host
 * still answers, as the model's own API does; a push, a Charm write or a share asks even where a
 * grant would answer, once, since a grant says the place is fine, not what the hob sends there.
 * Never and an Ask stay as they are: the mark only adds asks.
 */
const whileMarked = (
  context: PolicyContext,
  request: ResolvedRequest,
  answer: Answer,
  targets: ReadonlyArray<string>,
): Answer => {
  const kind = context.readWeb === true ? sendsOut(request) : null;
  if (kind === null || answer.decision !== "allow") return answer;
  const message = `This session read the web, so ${MARK_WORDS[kind]} waits for you: a page it read could have told it to send your data out.`;
  if (kind !== "host") return { decision: "ask", operation: answer.operation, code: "read-the-web", message };
  if (answer.code === "grant" || answer.code === "model-host") return answer;
  const host = targets[0] ?? "";
  // Where the preset allows the web, a saved Always for the host is read only now.
  const grant = context.grants?.find(
    (each) => each.operation === "use-web" && each.rule._tag === "Host" && normalizeHost(each.rule.host) === host,
  );
  if (grant !== undefined) {
    const message = `Your saved rule allows reaching ${host}.`;
    return { decision: "allow", operation: answer.operation, code: "grant", message, grantId: grant.id };
  }
  return {
    decision: "ask",
    operation: answer.operation,
    code: "read-the-web",
    message: `This session read the web, so reaching ${host}, a new host for its commands, waits for you: a page it read could have told it to send your data there.`,
    rule: { _tag: "Host", host },
  };
};

/** Decides a request whose paths are already canonical. Pure: the same inputs give the same verdict. */
export const evaluate = (context: PolicyContext, scope: ResolvedScope, request: ResolvedRequest): PolicyVerdict => {
  const parts = evaluateParts(context, scope, request);
  const { targets, onceOnly = false } = parts;
  const answers = parts.answers.map((answer) => whileMarked(context, request, answer, targets));
  const answer = pickNarrowest(answers) as Answer;
  // Ask offers a lifetime only when every part that asks could be answered by a rule.
  const asking = answer.decision === "ask" ? answers.filter((a) => a.decision === "ask") : [];
  const grantable = !onceOnly && asking.length > 0 && asking.every((a) => a.rule !== undefined);
  return {
    decision: answer.decision,
    operation: answer.operation,
    reason: { code: answer.code, message: answer.message },
    targets,
    enforcement: enforcementOf(context, answer.operation),
    onceOnly,
    grantable,
    rules: grantable ? uniqueRules(asking.flatMap((a) => (a.rule ? [a.rule] : []))) : [],
    grantIds: answer.decision === "allow" ? [...new Set(answers.flatMap((a) => (a.grantId ? [a.grantId] : [])))] : [],
    policyVersion: policyVersion(context),
  };
};

/** Each rule once, in order. */
export const uniqueRules = (rules: ReadonlyArray<GrantRule>): ReadonlyArray<GrantRule> => {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = stableJson(rule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export class PolicyEngine extends Context.Service<
  PolicyEngine,
  {
    /** Decides one request under the current context. Never fails: what it cannot resolve is denied. */
    readonly decide: (context: PolicyContext, request: PolicyRequest) => Effect.Effect<PolicyVerdict>;
  }
>()("@hobbots/permissions/PolicyEngine") {
  static readonly layer = Layer.effect(
    PolicyEngine,
    Effect.gen(function* () {
      const resolver = yield* PathResolver;
      // A relative path against a relative base, such as the folder after `cd "$DIR"` that the
      // command line could not settle, has no known location, so it is not resolved and stays closed.
      const unknown = (input: string, base: string) => !isAbsolute(input) && !isAbsolute(base);
      const unresolved = (input: string) => Effect.succeed<ResolvedTarget>({ input, canonical: null });
      const resolve = (input: string, base: string) =>
        unknown(input, base)
          ? unresolved(input)
          : resolver.canonicalize(input, base).pipe(
              Effect.map((canonical): ResolvedTarget => ({ input, canonical })),
              Effect.orElseSucceed((): ResolvedTarget => ({ input, canonical: null })),
            );
      const folder = (input: string) => resolve(input, "/");
      /** `inScope` holds the Git resources found across the hob's folders (`protectedGitPathsIn`). */
      const resolveChange = (input: string, base: string, inScope: ScopeGitResources) =>
        unknown(input, base)
          ? unresolved(input)
          : resolver.canonicalize(input, base).pipe(
              Effect.flatMap((canonical) =>
                resolver.protectedGitPaths(canonical).pipe(
                  Effect.map(
                    (own): ResolvedTarget => ({
                      input,
                      canonical,
                      protectedPaths: [...own, ...inScope.paths],
                      unsearched: inScope.unsearched.some((folder) => isInside(canonical, folder)),
                    }),
                  ),
                ),
              ),
              Effect.orElseSucceed((): ResolvedTarget => ({ input, canonical: null })),
            );

      /**
       * A saved-output folder's canonical path, or null when it is not below its root or a link lies
       * on the way to it, so its canonical path is not its root's followed by the same names.
       */
      const output = Effect.fnUntraced(function* ({ root, folder: path }: RuntimeOutput) {
        const below = relative(root, path);
        if (!isAbsolute(root) || below === "" || below.startsWith("..") || isAbsolute(below)) return null;
        const [base, resolved] = yield* Effect.all([folder(root), folder(path)]);
        if (base.canonical === null || resolved.canonical === null) return null;
        const expected = join(base.canonical.path, below);
        const exact =
          isInside(resolved.canonical, expected) &&
          isInside({ ...resolved.canonical, path: expected }, resolved.canonical.path);
        return exact ? resolved.canonical.path : null;
      });

      const scopeOf = Effect.fnUntraced(function* (context: PolicyContext) {
        const shared = yield* Effect.forEach(context.sharedFolders, folder);
        const hidden = yield* Effect.forEach(context.hob.hiddenSharedFolders, folder);
        const own = yield* Effect.forEach(context.hob.ownFolders, folder);
        const data = yield* folder(context.dataFolder);
        const outputs = yield* Effect.forEach(context.runtimeOutputs ?? [], output);
        const same = (a: CanonicalPath, b: CanonicalPath | null) =>
          b !== null && isInside(a, b.path) && isInside(b, a.path);
        const visible = shared.filter(
          (s) => s.canonical !== null && !hidden.some((h) => same(s.canonical as CanonicalPath, h.canonical)),
        );
        // A folder that cannot be resolved is left out, so nothing is reachable through it.
        const canonicalFolders = [...visible, ...own].flatMap((f) => (f.canonical === null ? [] : [f.canonical]));
        const folders = canonicalFolders.map((f) => f.path);
        // An unresolvable data folder keeps its stored form, which is still refused.
        const scope = {
          folders,
          dataFolder: data.canonical?.path ?? context.dataFolder,
          runtimeOutputs: outputs.flatMap((path) => (path === null ? [] : [path])),
        } satisfies ResolvedScope;
        return { scope, canonicalFolders };
      });

      const resolveRequest = (
        request: PolicyRequest,
        folders: ReadonlyArray<CanonicalPath>,
      ): Effect.Effect<ResolvedRequest> => {
        switch (request._tag) {
          case "Files": {
            const done = (targets: ReadonlyArray<ResolvedTarget>) =>
              ({ _tag: "Files", operation: request.operation, targets, exact: request.exact !== false }) as const;
            if (request.operation === "read-files") {
              return Effect.forEach(request.paths, (p) => resolve(p, request.cwd)).pipe(Effect.map(done));
            }
            return resolver.protectedGitPathsIn(folders).pipe(
              Effect.flatMap((inScope) =>
                Effect.forEach(request.paths, (p) => resolveChange(p, request.cwd, inScope)).pipe(Effect.map(done)),
              ),
              // Without the scope's Git resources nothing can be changed safely.
              Effect.orElseSucceed(() => done(request.paths.map((input) => ({ input, canonical: null })))),
            );
          }
          case "Command":
            // The runtime reports an absolute folder, so a relative one is a folder a command line moved to unknowably.
            return (isAbsolute(request.cwd) ? resolve(request.cwd, "/") : unresolved(request.cwd)).pipe(
              Effect.map(
                (cwd) =>
                  ({ _tag: "Command", operation: request.operation, cwd, words: request.words ?? null }) as const,
              ),
            );
          case "Push": {
            const { cwd, ...push } = request;
            return cwd === undefined
              ? Effect.succeed(push)
              : (isAbsolute(cwd) ? resolve(cwd, "/") : unresolved(cwd)).pipe(
                  Effect.map((resolved) => ({ ...push, cwd: resolved })),
                );
          }
          case "Charm": {
            const { folder, ...call } = request;
            return folder === undefined
              ? Effect.succeed(call)
              : (isAbsolute(folder) ? resolve(folder, "/") : unresolved(folder)).pipe(
                  Effect.map((resolved) => ({ ...call, folder: resolved })),
                );
          }
          default:
            // Web, Memory, Skills, Directory and Search name no path to resolve.
            return Effect.succeed(request);
        }
      };

      const hubHosts = yield* HubHosts;
      return {
        decide: (context, request) =>
          Effect.all([scopeOf(context), hubHosts.current]).pipe(
            Effect.flatMap(([{ scope, canonicalFolders }, hub]) =>
              resolveRequest(request, canonicalFolders).pipe(
                Effect.map((resolved) =>
                  evaluate({ ...context, hubHosts: [...(context.hubHosts ?? []), ...hub] }, scope, resolved),
                ),
              ),
            ),
          ),
      };
    }),
  );

  /** The engine resolving paths on the hub's own file system. */
  static readonly node = PolicyEngine.layer.pipe(Layer.provide(PathResolver.node));
}

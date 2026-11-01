import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  type Grant,
  GrantId,
  GrantRule,
  type HobPolicy,
  narrowest,
  PolicyDecision,
  PolicyOperation,
  type PolicyOverrides,
  PRESET_DECISIONS,
  ruleEnforcement,
  type SafetyPreset,
  type SandboxState,
  stableJson,
} from "@hobbots/domain";
import { Context, Effect, Layer, Schema } from "effect";
import { isBlockedHost, normalizeHost } from "./hosts.ts";
import { type CanonicalPath, isInside, PathResolver, type ScopeGitResources } from "./paths.ts";

/**
 * The policy engine of ADR 014: Allow, Ask or Deny for a normalized operation on a concrete
 * resource (PE-002). The effective answer is the narrowest of the preset, the hob's overrides and
 * every restriction the thread, Quest, task or delegation adds, so nothing can widen it (AG-004,
 * PE-004). Requests carry only the operation and its resource, never the model's account of it.
 */

/** Bumped whenever the rules below change meaning, so older decisions name the rules they followed. */
export const RULES_VERSION = 1;

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
  /** Narrowing added by the thread, Quest, task or delegation. Each may only narrow. */
  readonly restrictions: ReadonlyArray<PolicyOverrides>;
  /**
   * The hob's live grants, read again for every call (PE-008): not revoked and not expired. Only this
   * hob's: a grant never applies to another hob. Absent, no grant answers anything.
   */
  readonly grants?: ReadonlyArray<Grant>;
  /** The Quest the work belongs to, which a Quest grant must name; absent or null outside one. */
  readonly questId?: string | null;
}

export const FileOperation = Schema.Literals(["read-files", "edit-files", "delete-files"]);
export const CommandOperation = Schema.Literals(["run-commands", "local-git"]);

/** A normalized operation on its concrete resource. Relative paths resolve against `cwd`. */
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
  /** `cwd` is the folder the push runs in; without it a push cannot be granted. */
  Push: {
    remote: Schema.String,
    branch: Schema.String,
    force: Schema.Boolean,
    toDefaultBranch: Schema.Boolean,
    cwd: Schema.optionalKey(Schema.String),
  },
  /** A host the sandbox proxy was asked to reach, with the addresses it resolved to, if known. */
  Web: { host: Schema.String, addresses: Schema.Array(Schema.String) },
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
]);
export type ReasonCode = typeof ReasonCode.Type;

export const PolicyVerdict = Schema.Struct({
  decision: PolicyDecision,
  /** The operation decided, which becomes outside-folders for a target outside the hob's folders. */
  operation: PolicyOperation,
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
  | Extract<PolicyRequest, { readonly _tag: "Web" }>;

/**
 * A digest of the rules version and every policy input, so an approval binds to the exact policy.
 * Grants are left out: they are read again for every call and never pin a version (ADR 015).
 */
export const policyVersion = ({ grants, ...inputs }: PolicyContext): string =>
  `r${RULES_VERSION}-${createHash("sha256").update(stableJson(inputs)).digest("hex").slice(0, 16)}`;

interface Layered {
  readonly decision: PolicyDecision;
  readonly code: "preset" | "override" | "restriction";
  /** Whether the hob's override or any restriction answers Ask or Never, which no grant answers. */
  readonly narrowed: boolean;
}

/** The narrowest answer of the preset, the hob's override and each restriction, and who gave it. */
const layered = (context: PolicyContext, operation: PolicyOperation): Layered => {
  let result: Omit<Layered, "narrowed"> = { decision: PRESET_DECISIONS[context.preset][operation], code: "preset" };
  let narrowed = false;
  const consider = (decision: PolicyDecision | undefined, code: Layered["code"]) => {
    if (decision === undefined) return;
    if (decision !== "allow") narrowed = true;
    if (decision !== result.decision && narrowest(result.decision, decision) === decision) {
      result = { decision, code };
    }
  };
  consider(context.hob.overrides[operation], "override");
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
};

interface Answer {
  readonly decision: PolicyDecision;
  readonly operation: PolicyOperation;
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

/** The first live grant for this operation and site, bound to this Quest if it names one. */
const matchingGrant = (context: PolicyContext, operation: PolicyOperation, site: Site): Grant | undefined =>
  context.grants?.find(
    (grant) =>
      grant.operation === operation &&
      (grant.questId === null || grant.questId === (context.questId ?? null)) &&
      site.matches(grant.rule),
  );

/**
 * The layers' answer, and where only the preset asks, a live grant for the site (ADR 015 steps 5 to
 * 8). Without a site no rule can describe the call, so nothing is offered beyond once.
 */
const fromLayers = (context: PolicyContext, operation: PolicyOperation, site?: Site | null): Answer => {
  const { decision, code, narrowed } = layered(context, operation);
  const who = LAYER_MESSAGES[code];
  const answer: Answer = {
    decision,
    operation,
    code,
    message: `${who.charAt(0).toUpperCase()}${who.slice(1)} ${DECISION_WORDS[decision]} ${OPERATION_WORDS[operation]}.`,
  };
  if (decision !== "ask" || narrowed || !site) return answer;
  const grant = matchingGrant(context, operation, site);
  if (grant === undefined) return { ...answer, rule: site.rule };
  return {
    decision: "allow",
    operation,
    code: "grant",
    message: `Your saved rule allows ${OPERATION_WORDS[operation]} here.`,
    grantId: grant.id,
  };
};

const deny = (operation: PolicyOperation, code: ReasonCode, message: string): Answer => ({
  decision: "deny",
  operation,
  code,
  message,
});

/** Places a canonical target in the hob's scope: inside a folder (and which), or why not. */
const locate = (scope: ResolvedScope, target: ResolvedTarget): Located | Answer => {
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
  if (folder === undefined) {
    return deny("outside-folders", "outside-folders", `${canonical.path} is outside this hob's folders.`);
  }
  return { folder, canonical };
};

interface Located {
  readonly folder: string;
  readonly canonical: CanonicalPath;
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
  const place = locate(scope, target);
  // Every preset answers Deny outside the folders, and the narrowing layers cannot widen it.
  if (!located(place)) return place;
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

const enforcementOf = (context: PolicyContext, operation: PolicyOperation): PolicyVerdict["enforcement"] =>
  ruleEnforcement(operation, (other) => layered(context, other).decision, context.sandbox);

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
  const place = locate(scope, request.cwd);
  const answer = !located(place)
    ? place
    : (needsSandbox(context, request.operation) ??
      fromLayers(context, request.operation, commandSite(request.operation, place.canonical, request.words)));
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
    risky || cwd === null
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
  if (isBlockedHost(host) || addresses.some((a) => a === null || isBlockedHost(a))) {
    const message = `${host} is a loopback, link-local or cloud metadata address, never reachable from the sandbox.`;
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
  return { targets, answers: [fromLayers(context, "use-web", site)] };
};

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
  }
};

/** Decides a request whose paths are already canonical. Pure: the same inputs give the same verdict. */
export const evaluate = (context: PolicyContext, scope: ResolvedScope, request: ResolvedRequest): PolicyVerdict => {
  const { answers, targets, onceOnly = false } = evaluateParts(context, scope, request);
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
      const resolve = (input: string, base: string) =>
        resolver.canonicalize(input, base).pipe(
          Effect.map((canonical): ResolvedTarget => ({ input, canonical })),
          Effect.orElseSucceed((): ResolvedTarget => ({ input, canonical: null })),
        );
      const folder = (input: string) => resolve(input, "/");
      /** `inScope` holds the Git resources found across the hob's folders (`protectedGitPathsIn`). */
      const resolveChange = (input: string, base: string, inScope: ScopeGitResources) =>
        resolver.canonicalize(input, base).pipe(
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

      const scopeOf = Effect.fnUntraced(function* (context: PolicyContext) {
        const shared = yield* Effect.forEach(context.sharedFolders, folder);
        const hidden = yield* Effect.forEach(context.hob.hiddenSharedFolders, folder);
        const own = yield* Effect.forEach(context.hob.ownFolders, folder);
        const data = yield* folder(context.dataFolder);
        const same = (a: CanonicalPath, b: CanonicalPath | null) =>
          b !== null && isInside(a, b.path) && isInside(b, a.path);
        const visible = shared.filter(
          (s) => s.canonical !== null && !hidden.some((h) => same(s.canonical as CanonicalPath, h.canonical)),
        );
        // A folder that cannot be resolved is left out, so nothing is reachable through it.
        const canonicalFolders = [...visible, ...own].flatMap((f) => (f.canonical === null ? [] : [f.canonical]));
        const folders = canonicalFolders.map((f) => f.path);
        // An unresolvable data folder keeps its stored form, which is still refused.
        const scope = { folders, dataFolder: data.canonical?.path ?? context.dataFolder } satisfies ResolvedScope;
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
            return resolve(request.cwd, "/").pipe(
              Effect.map(
                (cwd) =>
                  ({ _tag: "Command", operation: request.operation, cwd, words: request.words ?? null }) as const,
              ),
            );
          case "Push": {
            const { cwd, ...push } = request;
            return cwd === undefined
              ? Effect.succeed(push)
              : resolve(cwd, "/").pipe(Effect.map((resolved) => ({ ...push, cwd: resolved })));
          }
          case "Web":
            return Effect.succeed(request);
        }
      };

      return {
        decide: (context, request) =>
          scopeOf(context).pipe(
            Effect.flatMap(({ scope, canonicalFolders }) =>
              resolveRequest(request, canonicalFolders).pipe(
                Effect.map((resolved) => evaluate(context, scope, resolved)),
              ),
            ),
          ),
      };
    }),
  );

  /** The engine resolving paths on the hub's own file system. */
  static readonly node = PolicyEngine.layer.pipe(Layer.provide(PathResolver.node));
}

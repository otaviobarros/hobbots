import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
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
export const RULES_VERSION = 2;

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
}

export const FileOperation = Schema.Literals(["read-files", "edit-files", "delete-files"]);
export const CommandOperation = Schema.Literals(["run-commands", "local-git"]);

/**
 * A normalized operation on its concrete resource. Relative paths resolve against `cwd`. A relative
 * `cwd` names a folder a command line moved to that could not be worked out, such as after
 * `cd "$DIR"`: it and the relative paths against it are not resolved, so they are refused.
 */
export const PolicyRequest = Schema.TaggedUnion({
  Files: { operation: FileOperation, paths: Schema.Array(Schema.String), cwd: Schema.String },
  Command: { operation: CommandOperation, cwd: Schema.String },
  Push: { remote: Schema.String, branch: Schema.String, force: Schema.Boolean, toDefaultBranch: Schema.Boolean },
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
  /** An approval for this call cannot be kept beyond the one call. */
  onceOnly: Schema.Boolean,
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
    }
  | { readonly _tag: "Command"; readonly operation: typeof CommandOperation.Type; readonly cwd: ResolvedTarget }
  | Extract<PolicyRequest, { readonly _tag: "Push" | "Web" }>;

/** A digest of the rules version and every policy input, so an approval binds to the exact policy. */
export const policyVersion = (context: PolicyContext): string =>
  `r${RULES_VERSION}-${createHash("sha256").update(stableJson(context)).digest("hex").slice(0, 16)}`;

interface Layered {
  readonly decision: PolicyDecision;
  readonly code: "preset" | "override" | "restriction";
}

/** The narrowest answer of the preset, the hob's override and each restriction, and who gave it. */
const layered = (context: PolicyContext, operation: PolicyOperation): Layered => {
  let result: Layered = { decision: PRESET_DECISIONS[context.preset][operation], code: "preset" };
  const consider = (decision: PolicyDecision | undefined, code: Layered["code"]) => {
    if (decision !== undefined && decision !== result.decision && narrowest(result.decision, decision) === decision) {
      result = { decision, code };
    }
  };
  consider(context.hob.overrides[operation], "override");
  for (const restriction of context.restrictions) consider(restriction[operation], "restriction");
  return result;
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
}

const fromLayers = (context: PolicyContext, operation: PolicyOperation): Answer => {
  const { decision, code } = layered(context, operation);
  const who = LAYER_MESSAGES[code];
  return {
    decision,
    operation,
    code,
    message: `${who.charAt(0).toUpperCase()}${who.slice(1)} ${DECISION_WORDS[decision]} ${OPERATION_WORDS[operation]}.`,
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

const fileTarget = (
  context: PolicyContext,
  scope: ResolvedScope,
  operation: typeof FileOperation.Type,
  target: ResolvedTarget,
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
  return fromLayers(context, operation);
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

/** Decides a request whose paths are already canonical. Pure: the same inputs give the same verdict. */
// complexity-ignore: predates the limit (STD-ARCH-012). Split it before adding branches.
export const evaluate = (context: PolicyContext, scope: ResolvedScope, request: ResolvedRequest): PolicyVerdict => {
  let answer: Answer;
  let targets: ReadonlyArray<string>;
  let onceOnly = false;
  switch (request._tag) {
    case "Files": {
      targets = request.targets.map((t) => t.canonical?.path ?? t.input);
      answer =
        pickNarrowest(request.targets.map((t) => fileTarget(context, scope, request.operation, t))) ??
        deny(request.operation, "no-target", "The call named no file, so there is nothing to allow.");
      break;
    }
    case "Command": {
      targets = [request.cwd.canonical?.path ?? request.cwd.input];
      const place = locate(scope, request.cwd);
      answer = !located(place)
        ? place
        : (needsSandbox(context, request.operation) ?? fromLayers(context, request.operation));
      break;
    }
    case "Push": {
      targets = [`${request.remote} ${request.branch}`];
      answer = fromLayers(context, "push");
      if ((request.force || request.toDefaultBranch) && answer.decision !== "deny") {
        answer = {
          ...answer,
          decision: "ask",
          code: "protected-push",
          message: request.force
            ? "A force push always waits for you, once only."
            : "A push to the default branch always waits for you, once only.",
        };
        onceOnly = true;
      }
      break;
    }
    case "Web": {
      const host = normalizeHost(request.host);
      targets = [host ?? request.host];
      const addresses = request.addresses.map(normalizeHost);
      const modelHosts = context.modelHosts.map(normalizeHost);
      if (host === null) {
        answer = deny("use-web", "invalid-host", `${request.host} is not a host name or address.`);
      } else if (isBlockedHost(host) || addresses.some((a) => a === null || isBlockedHost(a))) {
        answer = deny(
          "use-web",
          "blocked-host",
          `${host} is a loopback, link-local or cloud metadata address, never reachable from the sandbox.`,
        );
      } else {
        answer =
          needsSandbox(context, "use-web") ??
          (modelHosts.includes(host)
            ? {
                decision: "allow",
                operation: "use-web",
                code: "model-host",
                message: `${host} is the runtime's model API.`,
              }
            : fromLayers(context, "use-web"));
      }
      break;
    }
  }
  return {
    decision: answer.decision,
    operation: answer.operation,
    reason: { code: answer.code, message: answer.message },
    targets,
    enforcement: enforcementOf(context, answer.operation),
    onceOnly,
    policyVersion: policyVersion(context),
  };
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
              ({ _tag: "Files", operation: request.operation, targets }) as const;
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
              Effect.map((cwd) => ({ _tag: "Command", operation: request.operation, cwd }) as const),
            );
          default:
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

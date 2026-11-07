import {
  type AnyOperation,
  type DelegationAuthority,
  isNarrowerOrEqual,
  narrowest,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyLayer,
} from "@hobbots/domain";

/**
 * What a hob may do on a Task: an answer for every operation, built-in or declared by a Charm the hub
 * holds (ADR 031), and the folders it may use. An operation it has no answer for it may not do.
 */
export interface Authority {
  readonly decisions: Readonly<Record<AnyOperation, PolicyDecision>>;
  /**
   * The operations whose answer someone gave on purpose: a hob's override, a restriction or a
   * Delegation that asks or refuses. The rest follow the safety preset, which every hob shares.
   */
  readonly fixed: ReadonlyArray<AnyOperation>;
  readonly folders: ReadonlyArray<string>;
}

/** Nothing at all: what a hob without readable policy works with, closed and never open. */
export const NO_AUTHORITY: Authority = {
  decisions: Object.fromEntries(POLICY_OPERATIONS.map((operation) => [operation, "deny"])) as Authority["decisions"],
  fixed: POLICY_OPERATIONS,
  folders: [],
};

/**
 * The hub's path separator: `/` on macOS and Linux, `\` on Windows. Only the hub's own separator
 * divides folders, so on macOS and Linux `/work/project\outside` sits beside `/work/project`.
 */
export type PathSeparator = "/" | "\\";

/** Whether `folder` is `path` or holds it, on a hub whose paths divide at `separator`. Both are canonical. */
export const holds = (folder: string, path: string, separator: PathSeparator): boolean => {
  const base = folder.endsWith(separator) ? folder.slice(0, -separator.length) : folder;
  return path === base || path.startsWith(`${base}${separator}`);
};

/** The folders both lists allow: of each pair where one holds the other, the inner one. */
export const sharedFolders = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  separator: PathSeparator,
): ReadonlyArray<string> => [
  ...new Set(
    a.flatMap((one) =>
      b.flatMap((other) => (holds(one, other, separator) ? [other] : holds(other, one, separator) ? [one] : [])),
    ),
  ),
];

/** The operations an authority answers. */
export const operationsOf = (authority: Authority): ReadonlyArray<AnyOperation> =>
  Object.keys(authority.decisions) as ReadonlyArray<AnyOperation>;

/** `authority` narrowed by a Delegation above it: the narrower answer and only the folders both allow. */
export const narrowBy = (
  authority: Authority,
  delegation: DelegationAuthority,
  separator: PathSeparator,
): Authority => ({
  decisions: Object.fromEntries(
    operationsOf(authority).map((operation) => {
      const own = authority.decisions[operation] ?? "deny";
      const given = delegation.overrides[operation];
      return [operation, given === undefined ? own : narrowest(own, given)];
    }),
  ) as Authority["decisions"],
  fixed: operationsOf(authority).filter(
    (operation) => authority.fixed.includes(operation) || (delegation.overrides[operation] ?? "allow") !== "allow",
  ),
  folders:
    delegation.folders === null ? authority.folders : sharedFolders(authority.folders, delegation.folders, separator),
});

/** What a member may be given, or why a request asks for more than the lead has. */
export type Narrowed =
  | { readonly _tag: "Narrowed"; readonly authority: DelegationAuthority }
  | { readonly _tag: "Wider"; readonly message: string };

/**
 * The authority a lead gives a member: the lead's own, narrowed by what the brief asks for. A
 * request for anything the lead does not have is refused, never trimmed silently, so the lead
 * knows what the member can do. The member's own policy narrows it again when it runs.
 *
 * It holds an answer only where someone gave one on purpose: the lead's own override or
 * restriction, a Delegation above it, or the brief. Where the lead only follows the safety
 * preset, which the member follows too, it holds none, so the member's preset Ask stays one a
 * grant can answer, while an Ask given on purpose stays a restriction no grant answers (ADR 015).
 */
export const delegatedAuthority = (
  lead: Authority,
  requested: { readonly decisions?: PolicyLayer; readonly folders?: ReadonlyArray<string> } | undefined,
  separator: PathSeparator,
): Narrowed => {
  const asked: Readonly<Record<string, PolicyDecision | undefined>> = requested?.decisions ?? {};
  // An operation the lead has no answer for, such as one no Charm on the hub declares, is never given.
  const unknown = Object.keys(asked).filter((operation) => !(operation in lead.decisions));
  if (unknown.length > 0) {
    return { _tag: "Wider", message: `You cannot give what you do not have: ${unknown.join(", ")}.` };
  }
  const wider = operationsOf(lead).filter((operation) => {
    const want = asked[operation];
    return want !== undefined && !isNarrowerOrEqual(want, lead.decisions[operation] ?? "deny");
  });
  if (wider.length > 0) {
    const list = wider.map((operation) => `${operation} (yours is ${lead.decisions[operation]})`).join(", ");
    return { _tag: "Wider", message: `You cannot give more than you have: ${list}.` };
  }
  const outside = (requested?.folders ?? []).filter(
    (folder) => !lead.folders.some((own) => holds(own, folder, separator)),
  );
  if (outside.length > 0) {
    return { _tag: "Wider", message: `These folders are not yours to give: ${outside.join(", ")}.` };
  }
  return {
    _tag: "Narrowed",
    authority: {
      overrides: Object.fromEntries(
        operationsOf(lead).flatMap((operation) => {
          const want = asked[operation];
          const own = lead.decisions[operation] ?? "deny";
          if (want === undefined) return lead.fixed.includes(operation) ? [[operation, own]] : [];
          return [[operation, narrowest(own, want)]];
        }),
      ),
      folders: requested?.folders === undefined ? [...lead.folders] : [...requested.folders],
    },
  };
};

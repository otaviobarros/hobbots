import {
  type DelegationAuthority,
  isNarrowerOrEqual,
  narrowest,
  POLICY_OPERATIONS,
  type PolicyDecision,
  type PolicyOperation,
  type PolicyOverrides,
} from "@hobbots/domain";

/** What a hob may do on a Task: an answer for every operation, and the folders it may use. */
export interface Authority {
  readonly decisions: Record<PolicyOperation, PolicyDecision>;
  readonly folders: ReadonlyArray<string>;
}

/** Nothing at all: what a hob without readable policy works with, closed and never open. */
export const NO_AUTHORITY: Authority = {
  decisions: Object.fromEntries(POLICY_OPERATIONS.map((operation) => [operation, "deny"])) as Authority["decisions"],
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

/** `authority` narrowed by a Delegation above it: the narrower answer and only the folders both allow. */
export const narrowBy = (
  authority: Authority,
  delegation: DelegationAuthority,
  separator: PathSeparator,
): Authority => ({
  decisions: Object.fromEntries(
    POLICY_OPERATIONS.map((operation) => {
      const own = authority.decisions[operation];
      const given = delegation.overrides[operation];
      return [operation, given === undefined ? own : narrowest(own, given)];
    }),
  ) as Authority["decisions"],
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
 */
export const delegatedAuthority = (
  lead: Authority,
  requested: { readonly decisions?: PolicyOverrides; readonly folders?: ReadonlyArray<string> } | undefined,
  separator: PathSeparator,
): Narrowed => {
  const asked = requested?.decisions ?? {};
  const wider = POLICY_OPERATIONS.filter((operation) => {
    const want = asked[operation];
    return want !== undefined && !isNarrowerOrEqual(want, lead.decisions[operation]);
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
        POLICY_OPERATIONS.map((operation) => {
          const want = asked[operation];
          const own = lead.decisions[operation];
          return [operation, want === undefined ? own : narrowest(own, want)];
        }),
      ),
      folders: requested?.folders === undefined ? [...lead.folders] : [...requested.folders],
    },
  };
};

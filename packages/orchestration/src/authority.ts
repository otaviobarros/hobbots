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

/** Whether `folder` is `path` or holds it. Both are absolute; either separator counts. */
export const holds = (folder: string, path: string): boolean => {
  const base = folder.replace(/[/\\]+$/, "");
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
};

/** The folders both lists allow: of each pair where one holds the other, the inner one. */
export const sharedFolders = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(a.flatMap((one) => b.flatMap((other) => (holds(one, other) ? [other] : holds(other, one) ? [one] : [])))),
];

/** `authority` narrowed by a Delegation above it: the narrower answer and only the folders both allow. */
export const narrowBy = (authority: Authority, delegation: DelegationAuthority): Authority => ({
  decisions: Object.fromEntries(
    POLICY_OPERATIONS.map((operation) => {
      const own = authority.decisions[operation];
      const given = delegation.overrides[operation];
      return [operation, given === undefined ? own : narrowest(own, given)];
    }),
  ) as Authority["decisions"],
  folders: delegation.folders === null ? authority.folders : sharedFolders(authority.folders, delegation.folders),
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
  const outside = (requested?.folders ?? []).filter((folder) => !lead.folders.some((own) => holds(own, folder)));
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

import { Schema, SchemaTransformation } from "effect";
import { type AnyOperation, CharmId, CharmOperationId } from "./policy.ts";

/** The sites a standing grant can name, and the lifetimes a decision can carry (ADR 015). */

/**
 * How long a decision lasts: this one call, the request's top Task (This Task, or This Quest once a
 * party joins it; ADR 018), or until the user removes it.
 */
export const ApprovalLifetime = Schema.Literals(["once", "task", "always"]);
export type ApprovalLifetime = typeof ApprovalLifetime.Type;

/** The lifetimes that save a grant. */
export const GrantLifetime = Schema.Literals(["task", "always"]);
export type GrantLifetime = typeof GrantLifetime.Type;

const GrantFileOperation = Schema.Literals(["read-files", "edit-files", "delete-files"]);
const GrantCommandOperation = Schema.Literals(["run-commands", "local-git"]);

/**
 * What a grant allows, which is also the site it is for (ADR 015). Paths and folders are canonical.
 * - `Folder`: the files directly in one folder, not in its subfolders.
 * - `Paths`: exactly these files or folders.
 * - `Command`: exactly these literal words, run in exactly this folder.
 * - `Host`: exactly this host, lowercase and in ASCII form, without its subdomains.
 * - `Push`: a push to this remote and branch, from this folder.
 * - `CharmSite`: a Charm operation at this site (ADR 031): the values of every site field the
 *   operation declares, such as the repository and base branch of a pull request, from this folder
 *   when the call names one. Free text such as a title or a body changes with every call, so a rule
 *   never names it (ADR 020).
 */
const CurrentGrantRule = Schema.TaggedUnion({
  Folder: { operation: GrantFileOperation, folder: Schema.String },
  Paths: { operation: GrantFileOperation, paths: Schema.Array(Schema.String) },
  Command: { operation: GrantCommandOperation, cwd: Schema.String, words: Schema.Array(Schema.String) },
  Host: { host: Schema.String },
  Push: { cwd: Schema.String, remote: Schema.String, branch: Schema.String },
  CharmSite: {
    charm: CharmId,
    operation: CharmOperationId,
    cwd: Schema.optionalKey(Schema.String),
    site: Schema.Record(Schema.String, Schema.String),
  },
});
type CharmSiteRule = Extract<typeof CurrentGrantRule.Type, { readonly _tag: "CharmSite" }>;

/**
 * The GitHub rules stored before ADR 031: opening a pull request into a base branch of a repository,
 * and commenting on a repository, each from a folder. They decode as the `CharmSite` rules they became,
 * with the same site values.
 */
const LegacyGitHubRule = Schema.Union([
  Schema.TaggedStruct("PullRequest", { cwd: Schema.String, repository: Schema.String, base: Schema.String }),
  Schema.TaggedStruct("GitHubComment", { cwd: Schema.String, repository: Schema.String }),
]).pipe(
  Schema.decodeTo(
    CurrentGrantRule.cases.CharmSite,
    SchemaTransformation.transform({
      decode: (legacy): CharmSiteRule =>
        legacy._tag === "PullRequest"
          ? {
              _tag: "CharmSite",
              charm: "github",
              operation: "github.open-pull-request",
              cwd: legacy.cwd,
              site: { repository: legacy.repository, base: legacy.base },
            }
          : {
              _tag: "CharmSite",
              charm: "github",
              operation: "github.comment",
              cwd: legacy.cwd,
              site: { repository: legacy.repository },
            },
      // Only decoding reads the old shapes; a rule is always written as it is now.
      encode: (rule: CharmSiteRule) =>
        rule.operation === "github.open-pull-request"
          ? {
              _tag: "PullRequest" as const,
              cwd: rule.cwd ?? "",
              repository: rule.site.repository ?? "",
              base: rule.site.base ?? "",
            }
          : { _tag: "GitHubComment" as const, cwd: rule.cwd ?? "", repository: rule.site.repository ?? "" },
    }),
  ),
);

export const GrantRule = Schema.Union([CurrentGrantRule, LegacyGitHubRule]);
export type GrantRule = typeof GrantRule.Type;

/** The operation a rule is for. */
export const ruleOperation = (rule: GrantRule): AnyOperation => {
  switch (rule._tag) {
    case "Folder":
    case "Paths":
    case "Command":
    case "CharmSite":
      return rule.operation;
    case "Host":
      return "use-web";
    case "Push":
      return "push";
  }
};

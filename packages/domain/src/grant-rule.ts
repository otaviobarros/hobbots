import { Schema } from "effect";
import type { PolicyOperation } from "./policy.ts";

/** The sites a standing grant can name, and the lifetimes a decision can carry (ADR 015). */

/** How long a decision lasts: this one call, the request's Quest, or until the user removes it. */
export const ApprovalLifetime = Schema.Literals(["once", "quest", "always"]);
export type ApprovalLifetime = typeof ApprovalLifetime.Type;

/** The lifetimes that save a grant. */
export const GrantLifetime = Schema.Literals(["quest", "always"]);
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
 */
export const GrantRule = Schema.TaggedUnion({
  Folder: { operation: GrantFileOperation, folder: Schema.String },
  Paths: { operation: GrantFileOperation, paths: Schema.Array(Schema.String) },
  Command: { operation: GrantCommandOperation, cwd: Schema.String, words: Schema.Array(Schema.String) },
  Host: { host: Schema.String },
  Push: { cwd: Schema.String, remote: Schema.String, branch: Schema.String },
});
export type GrantRule = typeof GrantRule.Type;

/** The operation a rule is for. */
export const ruleOperation = (rule: GrantRule): PolicyOperation => {
  switch (rule._tag) {
    case "Folder":
    case "Paths":
    case "Command":
      return rule.operation;
    case "Host":
      return "use-web";
    case "Push":
      return "push";
  }
};

import type { HobPermissions } from "@hobbots/api";
import { type PolicyOperation, policySandbox } from "@hobbots/domain";
import { enforcement as ruleHolding } from "./safety.ts";

/**
 * What a hob's runtime enforces on this hub, as the profile shows it (PE-005, ADR 014). A rule the
 * hub cannot hold is shown as blocked, never as safe.
 */

type Declaration = HobPermissions["enforcement"];

/** The operations that run inside the sandbox, so the hub blocks them where it cannot start. */
const SANDBOX_OPERATIONS: ReadonlyArray<PolicyOperation> = ["run-commands", "local-git", "use-web"];

/** Why the sandbox counts as missing, or null where it is verified and holds. */
export const sandboxGap = (declaration: Declaration): "unsupported" | "unverified" | null => {
  const { status } = declaration.processSandbox;
  return status === "verified" ? null : status;
};

/**
 * Whether the hub blocks the operation because the sandbox is missing or not yet verified, whatever
 * its answer says (ADR 014: an unverified capability counts as missing).
 */
export const needsSandbox = (operation: PolicyOperation, declaration: Declaration): boolean =>
  policySandbox(declaration) === "unavailable" && SANDBOX_OPERATIONS.includes(operation);

/** How a built-in tool's operations are held on this hub, for its line on the Charms tab. */
export type ToolHolding =
  | { readonly kind: "needs-sandbox"; readonly gap: "unsupported" | "unverified" }
  | { readonly kind: "checked"; readonly labels: ReadonlyArray<string> }
  | { readonly kind: "held" };

export const toolHolding = (
  operations: ReadonlyArray<readonly [string, PolicyOperation]>,
  permissions: Pick<HobPermissions, "decisions" | "enforcement">,
): ToolHolding => {
  const { decisions, enforcement: declaration } = permissions;
  const gap = sandboxGap(declaration);
  if (gap !== null && operations.some(([, operation]) => needsSandbox(operation, declaration))) {
    return { kind: "needs-sandbox", gap };
  }
  const sandbox = policySandbox(declaration);
  const checked = operations.filter(([, operation]) => ruleHolding(operation, decisions, sandbox) === "checked");
  if (checked.length > 0) return { kind: "checked", labels: checked.map(([label]) => label) };
  return { kind: "held" };
};

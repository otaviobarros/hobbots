import type { HobPermissions } from "@hobbots/api";
import type { PolicyOperation, SandboxState } from "@hobbots/domain";
import { enforcement as ruleHolding } from "./safety.ts";

/**
 * What a hob's runtime enforces on this hub, as the profile shows it (PE-005, ADR 014). A rule the
 * hub cannot hold is shown as blocked, never as safe.
 */

type Declaration = HobPermissions["enforcement"];

/** The operations that run inside the sandbox, so the hub blocks them where it cannot start. */
const SANDBOX_OPERATIONS: ReadonlyArray<PolicyOperation> = ["run-commands", "local-git", "use-web"];

/**
 * The sandbox state the hub decides under. Only an unsupported sandbox blocks: an unverified one
 * still starts, and is shown as not yet verified.
 */
export const sandboxState = (declaration: Declaration): SandboxState =>
  declaration.processSandbox.status === "unsupported" ? "unavailable" : "on";

/** Whether the hub blocks the operation because the sandbox cannot start, whatever its answer says. */
export const needsSandbox = (operation: PolicyOperation, declaration: Declaration): boolean =>
  sandboxState(declaration) === "unavailable" && SANDBOX_OPERATIONS.includes(operation);

/** How a built-in tool's operations are held on this hub, for its line on the Charms tab. */
export type ToolHolding =
  | { readonly kind: "needs-sandbox" }
  | { readonly kind: "checked"; readonly labels: ReadonlyArray<string> }
  | { readonly kind: "held"; readonly verified: boolean };

export const toolHolding = (
  operations: ReadonlyArray<readonly [string, PolicyOperation]>,
  permissions: Pick<HobPermissions, "decisions" | "enforcement">,
): ToolHolding => {
  const { decisions, enforcement: declaration } = permissions;
  if (operations.some(([, operation]) => needsSandbox(operation, declaration))) return { kind: "needs-sandbox" };
  const sandbox = sandboxState(declaration);
  const checked = operations.filter(([, operation]) => ruleHolding(operation, decisions, sandbox) === "checked");
  if (checked.length > 0) return { kind: "checked", labels: checked.map(([label]) => label) };
  return { kind: "held", verified: declaration.processSandbox.status === "verified" };
};

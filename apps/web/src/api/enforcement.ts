import type { HobPermissions } from "@hobbots/api";
import { type AnyOperation, policySandbox } from "@hobbots/domain";

/**
 * What a hob's runtime enforces on this hub, as the profile shows it (PE-005, ADR 014). A rule the
 * hub cannot hold is shown as blocked, never as safe.
 */

type Declaration = HobPermissions["enforcement"];

/** The operations that run inside the sandbox, so the hub blocks them where it cannot start. */
const SANDBOX_OPERATIONS: ReadonlyArray<AnyOperation> = ["run-commands", "local-git", "use-web"];

/** Why the sandbox counts as missing, or null where it is verified and holds. */
export const sandboxGap = (declaration: Declaration): "unsupported" | "unverified" | null => {
  const { status } = declaration.processSandbox;
  return status === "verified" ? null : status;
};

/**
 * Whether the hub blocks the operation because the sandbox is missing or not yet verified, whatever
 * its answer says (ADR 014: an unverified capability counts as missing).
 */
export const needsSandbox = (operation: AnyOperation, declaration: Declaration): boolean =>
  policySandbox(declaration) === "unavailable" && SANDBOX_OPERATIONS.includes(operation);

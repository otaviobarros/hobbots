import type { RuntimeEnforcement } from "@hobbots/domain";

/** A runtime that holds everything Hobbots needs, or one whose sandbox cannot start, for tests. */
export const enforcementFixture = (
  sandbox: "verified" | "unverified" | "unsupported" = "verified",
): RuntimeEnforcement => ({
  toolInterception: { status: "verified", evidence: "Every tool call passes the policy hook." },
  processSandbox: {
    status: sandbox,
    evidence: sandbox === "unsupported" ? "sandbox-runtime is missing: bubblewrap" : "sandbox-runtime on darwin",
  },
  hubTools: {
    status: "verified",
    evidence: "Each Charm the hob holds and the hub's own tools are decided by the hub.",
  },
  toolEvents: { status: "verified", evidence: "Hooks report each call." },
  toolInterruption: { status: "verified", evidence: "Cancelling the turn aborts the runtime." },
  webSearch: { status: "verified", evidence: "Its own search passes the policy hook." },
});

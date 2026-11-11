import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { HubDecider, type Judgment } from "@hobbots/agents";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@hobbots/domain";
import { HubBrainDecider, MemoryModelEndpoint } from "@hobbots/memory";
import { PolicyEngine } from "@hobbots/permissions";
import { ClaudeCodeLayer, CodexLayer, ProcessSandbox } from "@hobbots/runtimes";
import { Effect, Layer, Redacted, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The hub's brain on the Claude Code and Codex this machine is signed in to (ADR 037, issue #1367).
 * It spends a little of each plan, so it runs only with HOBBOTS_SIGNED_IN=1, on a Mac where both
 * runtimes are installed and signed in.
 */
const enabled = process.env.HOBBOTS_SIGNED_IN === "1";

const workspace = mkdtempSync(join(tmpdir(), "hobbots-hub-brain-signed-in-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const sum: Judgment<"yes" | "no"> = {
  task: "judgments",
  question: "Is the statement in the input true?",
  input: "2 + 2 = 4",
  choices: Schema.Literals(["yes", "no"]),
  rule: "no",
};

const judge = (settings: MemorySettings) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decided = yield* (yield* HubDecider).decide(sum);
      return { decided, usage: yield* (yield* MemoryModelEndpoint).hubUsage };
    }).pipe(
      Effect.provide(
        HubBrainDecider(Effect.succeed(settings)).pipe(
          Layer.provideMerge(MemoryModelEndpoint.layer(Redacted.make("k".repeat(64)))),
          Layer.provide(
            Layer.mergeAll(
              ClaudeCodeLayer({ workspaceDir: workspace }),
              CodexLayer({ clientVersion: "0.0.0", workspaceDir: workspace }).pipe(Layer.provide(NodeServices.layer)),
            ).pipe(Layer.provide(ProcessSandbox.layer), Layer.provide(PolicyEngine.node)),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );

describe.runIf(enabled)("the hub's brain on signed-in runtimes", () => {
  // covers ADR 037
  it.each(["claude", "chatgpt"] as const)(
    "[TC-GEN-1367-08] the %s provider answers a judgment in its shape through the hub's endpoint, counted for Usage",
    { timeout: 180_000 },
    async (provider) => {
      const { decided, usage } = await judge({ ...DEFAULT_MEMORY_SETTINGS, provider });
      expect(decided.by).toBe("brain");
      expect(decided.choice).toBe("yes");
      expect(decided.confidence).toBeGreaterThanOrEqual(0);
      expect(decided.confidence).toBeLessThanOrEqual(1);
      expect(usage.calls).toBe(1);
    },
  );
});

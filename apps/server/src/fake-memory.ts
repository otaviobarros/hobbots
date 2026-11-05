import { MemoryStore } from "@hobbots/agents";
import { type AgentId, type MemoryActor, MemoryPath, type MemoryScope, memoryProjectIdentity } from "@hobbots/domain";
import { makeMemoryStoreFake } from "@hobbots/memory/testing";
import { Effect, Layer, Stream } from "effect";
import { EventBus } from "./event-bus.ts";

/**
 * An in-memory stand-in for the memory engine (ADR 028), so the Memory page can be tried and tested
 * end to end before hobs save to memory themselves. `down` answers that memory is unavailable.
 * `seeded` holds a few pages About you and in one project, and gives every hob a few pages of its
 * own as it is summoned, saved as that hob, as its first chats would, and flags the annual plan as out
 * of date, for Check now to find. Only `HOBBOTS_FAKE_MEMORY` turns it on.
 */

const page = (path: string, markdown: string, pinned = false) => ({
  path: MemoryPath.make(path),
  markdown,
  tags: [],
  pinned,
});

/** A project with no remote, named after its folder, as a hob working in `~/code/site` would make. */
const FAKE_MEMORY_PROJECT = memoryProjectIdentity(null, "site");

const ABOUT_YOU = [
  page(
    "rules/ask-before-sending.md",
    "# Ask before sending anything outside the hub\n\nEmails, posts and messages wait for your yes.",
    true,
  ),
  page("rules/use-pnpm.md", "# Use pnpm, not npm\n\nEvery project here installs with pnpm."),
];

const PROJECT = [
  page(
    "howtos/publish-the-site.md",
    "# Publishing the site\n\n`pnpm deploy` builds and uploads. It asks you first.\n\n`pnpm deploy --preview` makes a link that works for 7 days.",
    true,
  ),
  page("facts/annual-plan.md", "# The annual plan costs $10 a month\n\nFrom the pricing page."),
];

const OWN = (name: string) => [
  page(
    "howtos/preview-link.md",
    `# Publishing a preview link\n\nWhen a launch email needs a link to the new page, ask for a preview link.\n\n1. Check that the task shows the preview as done.\n2. Copy the link from its result, not from the terminal.\n\n${name} learned this by doing it.`,
  ),
  page(
    "gotchas/link-before-email.md",
    "# The preview link must exist before the email\n\nWriting the email first wasted three tries.",
  ),
  page("decisions/tuesday.md", "# The launch email goes out Tuesday at 9 AM\n\nDecided with you."),
  page("sessions/first-chat.md", "# Write the launch email\n\n3 tries, stopped for the preview link."),
];

const asHob = (agentId: AgentId): MemoryActor => ({ _tag: "Hob", agentId, projects: [FAKE_MEMORY_PROJECT] });

/** The fake memory, as `HOBBOTS_FAKE_MEMORY` chooses it. */
export const FakeMemoryLive = (mode: "empty" | "seeded" | "down") =>
  Layer.effect(
    MemoryStore,
    Effect.gen(function* () {
      const { store, controls } = makeMemoryStoreFake();
      if (mode === "down") controls.setDown(true);
      if (mode !== "seeded") return store;
      const you: MemoryActor = { _tag: "You" };
      const everyone: MemoryScope = { _tag: "Everyone" };
      const project: MemoryScope = { _tag: "Project", identity: FAKE_MEMORY_PROJECT };
      const fresh = { _tag: "New" } as const;
      yield* Effect.forEach(ABOUT_YOU, (draft) => store.write(you, everyone, draft, fresh));
      yield* Effect.forEach(PROJECT, (draft) => store.write(you, project, draft, fresh));
      controls.flag({
        kind: "stale",
        scope: project,
        paths: [MemoryPath.make("facts/annual-plan.md")],
        message: "The pricing page changed since this was saved.",
      });
      // Each hob's pages are saved once, as that hob, when it is first upserted.
      const seeded = new Set<string>();
      const bus = yield* EventBus;
      yield* bus.stream.pipe(
        Stream.runForEach((event) => {
          if (event._tag !== "Journaled" || event.entry.payload._tag !== "AgentUpserted") return Effect.void;
          const hob = event.entry.payload.agent;
          if (hob.status !== "active" || seeded.has(hob.id)) return Effect.void;
          seeded.add(hob.id);
          const own: MemoryScope = { _tag: "Hob", agentId: hob.id };
          return Effect.forEach(OWN(hob.name), (draft) => store.write(asHob(hob.id), own, draft, fresh)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Could not seed a hob's fake memory", cause)),
          );
        }),
        Effect.forkScoped,
      );
      return store;
    }).pipe(Effect.orDie),
  );

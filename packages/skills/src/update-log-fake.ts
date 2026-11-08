import { SkillUpdateLog, type SkillUpdateLogShape } from "@hobbots/agents";
import { type Committed, type SkillId, SkillUpdate, type SkillUpdateCheck } from "@hobbots/domain";
import { Effect, Layer } from "effect";

/**
 * Updates from a source in memory, for tests: the port's rules without a database. It journals
 * nothing, so every change answers no entries.
 */

const committed = <A>(value: A): Committed<A> => ({ value, entries: [] });

export const makeSkillUpdateLogFake = (): SkillUpdateLogShape => {
  const updates = new Map<SkillId, SkillUpdate>();
  const automatic = new Set<SkillId>();
  let last: SkillUpdateCheck = { checkedAt: null, problems: [] };
  return {
    waiting: Effect.sync(() =>
      [...updates.values()].filter((one) => one.state === "waiting").sort((a, b) => a.name.localeCompare(b.name)),
    ),
    get: (skillId) => Effect.sync(() => updates.get(skillId) ?? null),
    found: (update) =>
      Effect.sync(() => {
        if (updates.get(update.skillId)?.hash === update.hash) return null;
        updates.set(update.skillId, update);
        return committed(update);
      }),
    dismiss: (skillId, hash) =>
      Effect.sync(() => {
        const before = updates.get(skillId);
        if (before === undefined || before.hash !== hash || before.state !== "waiting") return null;
        const update = new SkillUpdate({ ...before, state: "dismissed" });
        updates.set(skillId, update);
        return committed(update);
      }),
    clear: (skillId, hash) =>
      Effect.sync(() => {
        const before = updates.get(skillId);
        if (before === undefined || (hash !== undefined && before.hash !== hash)) return null;
        updates.delete(skillId);
        return committed(skillId);
      }),
    automatic: Effect.sync(() => [...automatic].sort()),
    setAutomatic: (skillId, on) =>
      Effect.sync(() => {
        if (automatic.has(skillId) === on) return null;
        if (on) automatic.add(skillId);
        else automatic.delete(skillId);
        return committed(on);
      }),
    lastCheck: Effect.sync(() => last),
    checked: (at, problems) =>
      Effect.sync(() => {
        last = { checkedAt: at, problems };
      }),
  };
};

export const SkillUpdateLogFake = Layer.sync(SkillUpdateLog, makeSkillUpdateLogFake);

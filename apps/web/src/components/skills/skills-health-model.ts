import type { SkillHealth } from "@hobbots/api";
import { type AgentId, skillTitle } from "@hobbots/domain";
import { messages } from "./messages.ts";
import { type HobDirectory, type SkillsView, scopeName, skillView } from "./skills-model.ts";

const copy = messages.health;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One line of Worth a look: what deserves a look, why, and where you act on it. */
export interface HealthItem {
  readonly key: string;
  /** `warn` when a hob is worse off for it now, `info` when it is only worth knowing. */
  readonly tone: "warn" | "info";
  readonly title: string;
  readonly hint: string;
  readonly to: SkillsView;
}

const hobView = (agentId: AgentId): SkillsView => ({ _tag: "Scope", scope: { _tag: "Hob", agentId } });

const hobName = (hobs: HobDirectory, agentId: AgentId): string => hobs.get(agentId)?.name ?? copy.aHob;

const unusedItems = (health: SkillHealth, now: Date): ReadonlyArray<HealthItem> =>
  health.unused.map((one) => {
    const name = skillTitle(one.name);
    const days = one.lastUsedAt === null ? null : Math.floor((now.getTime() - Date.parse(one.lastUsedAt)) / DAY_MS);
    return {
      key: `unused:${one.skillId}`,
      tone: "warn",
      title: days === null ? copy.neverUsed({ name }) : copy.unused({ name, days }),
      hint: copy.unusedHint({ count: one.assignments }),
      to: skillView(one.skillId, "who"),
    };
  });

const behindItems = (health: SkillHealth, hobs: HobDirectory): ReadonlyArray<HealthItem> =>
  health.behind.map((one) => {
    const who = scopeName(one.scope, hobs);
    const name = skillTitle(one.name);
    const latest = `r${one.latest}`;
    return {
      key: `behind:${one.assignmentId}`,
      tone: one.held && one.number !== null ? "info" : "warn",
      title: one.number === null ? copy.behindLost({ who, name }) : copy.behind({ who, name, rev: `r${one.number}` }),
      hint: copy.behindHint({ latest, held: one.held }),
      to: skillView(one.skillId, "who"),
    };
  });

const clashItems = (health: SkillHealth, hobs: HobDirectory): ReadonlyArray<HealthItem> =>
  health.clashes.map((one) => {
    const hob = hobName(hobs, one.agentId);
    const name = skillTitle(one.name);
    const [title, hint] =
      one.kind === "projects"
        ? [copy.clashProjects({ hob, name }), copy.clashProjectsHint]
        : one.kind === "replaced"
          ? [copy.clashReplaced({ hob, name }), copy.clashReplacedHint]
          : [copy.clashSame({ hob, name }), copy.clashSameHint];
    return {
      key: `clash:${one.agentId}:${one.kind}:${one.name}`,
      tone: one.kind === "replaced" ? "info" : "warn",
      title,
      hint,
      to: hobView(one.agentId),
    };
  });

const descriptionItems = (health: SkillHealth): ReadonlyArray<HealthItem> =>
  health.descriptions.map((one) => {
    const name = skillTitle(one.name);
    return {
      key: `description:${one.skillId}:${one.name}`,
      tone: "info",
      title: one.problem === "long" ? copy.long({ name, length: one.length }) : copy.vague({ name }),
      hint: one.problem === "long" ? copy.longHint : copy.vagueHint,
      to:
        one.set === null
          ? skillView(one.skillId)
          : { _tag: "Skill", skillId: one.skillId, member: one.name, tab: null, file: null, diff: null },
    };
  });

/**
 * Worth a look, in the order it matters (ADR 029, Health checks): what keeps a skill from loading
 * first, then places behind, skills nobody uses, and descriptions that may not trigger.
 */
export const healthItems = (health: SkillHealth, hobs: HobDirectory, now: Date): ReadonlyArray<HealthItem> => {
  const items = [
    ...clashItems(health, hobs),
    ...behindItems(health, hobs),
    ...unusedItems(health, now),
    ...descriptionItems(health),
  ];
  return [...items.filter((one) => one.tone === "warn"), ...items.filter((one) => one.tone === "info")];
};

/** One hob's row of What each hob carries. */
export interface LoadRow {
  readonly agentId: AgentId;
  readonly name: string;
  readonly count: number;
  /** How much of its listing budget the descriptions take, rounded, which may pass 100. */
  readonly percent: number;
  /** Whether it carries enough that it may pick the right skill less often. */
  readonly heavy: boolean;
  readonly to: SkillsView;
}

/** Past this many skills a hob picks the right one less often, whatever their descriptions take. */
const MANY_SKILLS = 30;

/** Past this share of its budget, a hob's listing is near the point where the runtime drops descriptions. */
const HEAVY_PERCENT = 75;

/** What each hob carries, the most loaded first; hobs with no skill are left out. */
export const loadRows = (health: SkillHealth, hobs: HobDirectory): ReadonlyArray<LoadRow> =>
  health.loads
    .filter((one) => one.skills > 0)
    .map((one) => {
      const percent = Math.round((one.characters / one.budget) * 100);
      return {
        agentId: one.agentId,
        name: hobName(hobs, one.agentId),
        count: one.skills,
        percent,
        heavy: percent > HEAVY_PERCENT || one.skills > MANY_SKILLS,
        to: hobView(one.agentId),
      };
    })
    .sort((a, b) => b.percent - a.percent || b.count - a.count || a.name.localeCompare(b.name));

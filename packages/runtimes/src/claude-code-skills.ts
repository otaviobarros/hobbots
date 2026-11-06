import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, SkillMount } from "@hobbots/agents";
import { stepEnds } from "./hub-tools.ts";
import { SKILLS_PLUGIN, type SkillFolder } from "./skills.ts";

/** Claude Code's tool that loads a skill's instructions. */
export const SKILL_TOOL = "Skill";

/** The name Claude Code gives a mounted skill, from Hobbots' plugin. */
export const pluginSkill = (name: string) => `${SKILLS_PLUGIN}:${name}`;

const skillOf = (input: unknown): string | undefined => {
  const skill = (input as { readonly skill?: unknown } | null)?.skill;
  return typeof skill === "string" ? skill : undefined;
};

/**
 * Claude Code's options for a turn's skills (ADR 029): the turn's folder as a plugin that brings
 * skills only (`skipMcpDiscovery`), and the `skills` list naming each, so the model's listing holds
 * only the hob's skills and the Skill tool refuses any other. Without skills the list is empty, so
 * Claude Code's own built-in skills stay out of the listing too.
 *
 * With skills, the turn offers the Skill tool, which only reads a mounted skill's instructions: the
 * hook approves its calls rather than the policy, and shows each as a step. Shell commands inside a
 * skill's text never run (`disableSkillShellExecution`, in the turn's settings); the commands a skill
 * asks for run as the hob's own, under its policy.
 */
export const withSkills = (
  options: Options,
  folder: SkillFolder | null,
  mounts: ReadonlyArray<SkillMount> | null | undefined,
  report: (event: RuntimeEvent) => void,
): Options => {
  if (folder === null || !mounts || mounts.length === 0) return { ...options, skills: [] };
  const known = new Set(mounts.map((mount) => pluginSkill(mount.name)));
  const started = new Set<string>();
  const start: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== SKILL_TOOL) return {};
    const skill = skillOf(input.tool_input);
    // Claude Code refuses a skill the list leaves out; the hook lets it say so.
    if (skill === undefined || !known.has(skill)) return {};
    started.add(input.tool_use_id);
    const name = skill.slice(SKILLS_PLUGIN.length + 1);
    report({ _tag: "StepStarted", id: input.tool_use_id, kind: "tool", label: `Reading the ${name} skill` });
    // The model picked the skill: the reply shows it used it (ADR 029, The use line).
    report({ _tag: "SkillUsed", name, explicit: false });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "A skill Hobbots gave this hob.",
      },
    };
  };
  const end = stepEnds(started, report);
  const matcher = `^${SKILL_TOOL}$`;
  const hooks = options.hooks ?? {};
  return {
    ...options,
    plugins: [{ type: "local", path: folder.folder, skipMcpDiscovery: true }],
    skills: [...known],
    tools: [...(Array.isArray(options.tools) ? options.tools : []), SKILL_TOOL],
    // A chat-only turn closes every tool with `*`, which would close the Skill tool too.
    disallowedTools: (options.disallowedTools ?? []).filter((rule) => rule !== "*"),
    hooks: {
      ...hooks,
      PreToolUse: [...(hooks.PreToolUse ?? []), { matcher, hooks: [start] }],
      PostToolUse: [...(hooks.PostToolUse ?? []), { matcher, hooks: [end] }],
      PostToolUseFailure: [...(hooks.PostToolUseFailure ?? []), { matcher, hooks: [end] }],
    },
  };
};

/**
 * The prompt for a turn you picked a skill for: Claude Code's own mention, `/hobbots-skills:<name>`,
 * ahead of the rest, which Claude Code hands the skill as its arguments.
 */
export const askedSkillPrompt = (prompt: string, asked: SkillMount | null): string =>
  asked === null ? prompt : `/${pluginSkill(asked.name)} ${prompt}`;

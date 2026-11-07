import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent, SkillMount } from "@hobbots/agents";
import { stepEnds } from "./hub-tools.ts";
import { SKILLS_PLUGIN, type SkillFolder } from "./skills.ts";

/** The name Claude Code gives a mount: from its set's plugin, or from Hobbots' plugin (ADR 029, Skill sets). */
const mountSkill = (mount: SkillMount) => (mount.set ? `${mount.set.name}:${mount.name}` : pluginSkill(mount.name));

/** Claude Code's tool that loads a skill's instructions. */
export const SKILL_TOOL = "Skill";

/** The name Claude Code gives a mounted skill, from Hobbots' plugin. */
export const pluginSkill = (name: string) => `${SKILLS_PLUGIN}:${name}`;

/** Claude Code's tool that reads a file, which a skill's links are followed with. */
export const READ_TOOL = "Read";

/**
 * Whether a Read reaches only a file of the turn's skill folder (ADR 029, Skill sets): the target as
 * it resolves, links and `..` included, must be inside the folder as it resolves. Such a read is the
 * hob following a skill's link to one of its files, or its set's, which are read-only library content.
 */
export const readsSkillFile = (input: unknown, folder: string | null | undefined): boolean => {
  const path = (input as { readonly file_path?: unknown } | null)?.file_path;
  if (folder === null || folder === undefined || typeof path !== "string" || !isAbsolute(path)) return false;
  try {
    return realpathSync(path).startsWith(`${realpathSync(folder)}${sep}`);
  } catch {
    return false;
  }
};

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
  const known = new Map(mounts.map((mount) => [mountSkill(mount), mount]));
  const started = new Set<string>();
  const start: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== SKILL_TOOL) return {};
    const skill = skillOf(input.tool_input);
    // Claude Code refuses a skill the list leaves out; the hook lets it say so.
    const mount = skill === undefined ? undefined : known.get(skill);
    if (mount === undefined) return {};
    started.add(input.tool_use_id);
    const { name } = mount;
    report({ _tag: "StepStarted", id: input.tool_use_id, kind: "tool", label: `Reading the ${name} skill` });
    // The model picked the skill: the reply shows it used it (ADR 029, The use line).
    report({
      _tag: "SkillUsed",
      source: "library",
      name,
      explicit: false,
      ...(mount.set ? { set: mount.set.name } : {}),
    });
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
  const offered = Array.isArray(options.tools) ? options.tools : [];
  // A chat-only turn has no Read of its own: it gets one that reads only the skill folder, so the hob
  // can follow a skill's links to its other files and its set's (ADR 029, Skill sets).
  const chatOnly = !offered.includes(READ_TOOL);
  const read: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== READ_TOOL) return {};
    if (readsSkillFile(input.tool_input, folder.folder)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "A file of a skill Hobbots gave this hob.",
        },
      };
    }
    // With tools, the policy decides every other read; a chat-only turn reads nothing else.
    if (!chatOnly) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "This chat reads only the files of its skills.",
      },
    };
  };
  return {
    ...options,
    // Hobbots' plugin for the loose skills, and one plugin per set, named after it (ADR 029, Skill sets).
    plugins: [folder.folder, ...folder.sets.map((set) => set.folder)].map((path) => ({
      type: "local" as const,
      path,
      skipMcpDiscovery: true,
    })),
    skills: [...known.keys()],
    tools: [...offered, SKILL_TOOL, ...(chatOnly ? [READ_TOOL] : [])],
    // A chat-only turn closes every tool with `*`, which would close the Skill tool too.
    disallowedTools: (options.disallowedTools ?? []).filter((rule) => rule !== "*"),
    hooks: {
      ...hooks,
      PreToolUse: [
        ...(hooks.PreToolUse ?? []),
        { matcher, hooks: [start] },
        { matcher: `^${READ_TOOL}$`, hooks: [read] },
      ],
      PostToolUse: [...(hooks.PostToolUse ?? []), { matcher, hooks: [end] }],
      PostToolUseFailure: [...(hooks.PostToolUseFailure ?? []), { matcher, hooks: [end] }],
    },
  };
};

/**
 * The prompt for a turn you picked a skill for: Claude Code's own mention, `/hobbots-skills:<name>`
 * or `/<set>:<name>`, ahead of the rest, which Claude Code hands the skill as its arguments. Always
 * the prefixed form: Claude Code picks the first plugin's skill for a bare name two plugins share.
 */
export const askedSkillPrompt = (prompt: string, asked: SkillMount | null): string =>
  asked === null ? prompt : `/${mountSkill(asked)} ${prompt}`;

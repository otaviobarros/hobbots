import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type HubTools, type SkillMount, type ToolStartedEvent, UNRECORDED_TOOL_CALL } from "@hobbots/agents";
import { Effect } from "effect";

// The clean-runtime fixture (ADR 029): a fake home folder and a repository that hold a skill, an MCP
// server, a plugin, a hook and instruction files in every place Claude Code and Codex read, a skill
// in `~/.agents/skills`, and the library revisions Hobbots mounts for the turn.

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** A skill folder's `SKILL.md`, whose description carries a marker the model would read. */
const skill = (folder: string, name: string) =>
  write(
    join(folder, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: Marker ${name}-offered.\n---\n\nUse ${name}.\n`,
  );

/** Names of skills Hobbots never gives a hob, one per place a runtime reads. */
export const FOREIGN_SKILLS = [
  "home-claude-skill",
  "home-claude-plugin-skill",
  "home-codex-skill",
  "repo-claude-skill",
  "repo-agents-skill",
  "repo-codex-skill",
] as const;

/** Markers that must never reach what the model is offered. */
export const FOREIGN_MARKERS = [
  ...FOREIGN_SKILLS.map((name) => `${name}-offered`),
  "home-claude-instructions",
  "home-codex-instructions",
  "home-mcp-tool",
  "repo-mcp-tool",
  // A skill of a mounted set that the hob turned off (ADR 029, Skill sets).
  "skipped-it-offered",
] as const;

/** The skill in `~/.agents/skills`, which reaches a hob only as a mount Hobbots serves. */
export const AGENTS_SKILL = "shared-agents-skill";

/** The library's skills the turn mounts: one the hob may pick, one Only when asked. */
export const LIBRARY_SKILL = "library-skill";
export const ASKED_SKILL = "asked-skill";

/**
 * A set the turn mounts (ADR 029, Skill sets): `plan-it` and `ship-it` under `skills/`, which link to
 * the set's `references/rules.md` and to each other, and `skipped-it`, which the hob turned off.
 */
export const TEAM_SET = "team-set";
export const SET_SKILL = "plan-it";
export const SET_SIBLING = "ship-it";
export const SET_SKIPPED = "skipped-it";
/** What the set's shared file says, which a turn reads only by following a link. */
export const SET_RULES = "Marker team-rules-read.";

export interface CleanRuntimeFixture {
  readonly home: string;
  readonly repo: string;
  /** Files a hook or an MCP server writes if it ever runs. */
  readonly ranMarkers: ReadonlyArray<string>;
  readonly mounts: ReadonlyArray<SkillMount>;
}

/** An MCP server that leaves a file behind if anything starts it. */
const mcpServer = (marker: string) => ({ command: "sh", args: ["-c", `touch '${marker}'`] });

/** A hook that leaves a file behind if it runs. */
const hookSettings = (marker: string) => ({
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: `touch '${marker}'` }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch '${marker}'` }] }],
  },
});

export const cleanRuntimeFixture = (root: string): CleanRuntimeFixture => {
  const home = join(root, "home");
  const repo = join(root, "repo");
  const ran = join(root, "ran");
  const marker = (name: string) => join(ran, name);
  mkdirSync(ran, { recursive: true });

  // Claude Code's own setup.
  skill(join(home, ".claude", "skills"), "home-claude-skill");
  write(join(home, ".claude", "CLAUDE.md"), "Marker home-claude-instructions.\n");
  write(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ ...hookSettings(marker("home-claude-hook")), enabledPlugins: { "home-plugin@local": true } }),
  );
  write(
    join(home, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { "home-mcp-tool": mcpServer(marker("home-claude-mcp")) },
    }),
  );
  const plugin = join(home, ".claude", "plugins", "local", "home-plugin");
  write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "home-plugin" }));
  skill(join(plugin, "skills"), "home-claude-plugin-skill");
  write(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { "home-mcp-tool": mcpServer(marker("plugin-mcp")) } }),
  );
  write(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "home-plugin@local": [{ scope: "user", installPath: plugin, version: "1.0.0" }] },
    }),
  );

  // Codex's own setup.
  skill(join(home, ".codex", "skills"), "home-codex-skill");
  write(join(home, ".codex", "AGENTS.md"), "Marker home-codex-instructions.\n");
  write(
    join(home, ".codex", "config.toml"),
    `[mcp_servers.home-mcp-tool]\ncommand = "sh"\nargs = ["-c", "touch '${marker("home-codex-mcp")}'"]\n`,
  );

  // The shared folder, which Hobbots serves under Everyone.
  skill(join(home, ".agents", "skills"), AGENTS_SKILL);

  // A repository with skills, an MCP server and hooks of its own.
  mkdirSync(join(repo, ".git"), { recursive: true });
  skill(join(repo, ".claude", "skills"), "repo-claude-skill");
  skill(join(repo, ".agents", "skills"), "repo-agents-skill");
  skill(join(repo, ".codex", "skills"), "repo-codex-skill");
  write(join(repo, ".claude", "settings.json"), JSON.stringify(hookSettings(marker("repo-claude-hook"))));
  write(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { "repo-mcp-tool": mcpServer(marker("repo-mcp")) } }));
  write(
    join(repo, ".codex", "config.toml"),
    `[mcp_servers.repo-mcp-tool]\ncommand = "sh"\nargs = ["-c", "touch '${marker("repo-codex-mcp")}'"]\n`,
  );

  // The library's revisions, as the hub keeps them, and the `~/.agents` skill as the hub serves it.
  const objects = join(root, "objects");
  skill(objects, LIBRARY_SKILL);
  skill(objects, ASKED_SKILL);
  skill(join(objects, "agents"), AGENTS_SKILL);
  const set = join(objects, "sets", TEAM_SET);
  write(
    join(set, "skills", SET_SKILL, "SKILL.md"),
    `---\nname: ${SET_SKILL}\ndescription: Marker ${SET_SKILL}-offered.\n---\n\nUse ${SET_SKILL}. Read the [rules](../../references/rules.md) and [ship](../${SET_SIBLING}/SKILL.md).\n`,
  );
  skill(join(set, "skills"), SET_SIBLING);
  skill(join(set, "skills"), SET_SKIPPED);
  write(join(set, "references", "rules.md"), `${SET_RULES}\n`);
  const member = (name: string): SkillMount => ({
    name,
    revision: `${TEAM_SET}-r1`,
    folder: set,
    implicit: true,
    set: { name: TEAM_SET, path: `skills/${name}` },
  });
  const mount = (name: string, folder: string, implicit = true): SkillMount => ({
    name,
    revision: `${name}-r1`,
    folder: join(folder, name),
    implicit,
  });
  return {
    home,
    repo,
    ranMarkers: [
      "home-claude-hook",
      "home-claude-mcp",
      "plugin-mcp",
      "home-codex-mcp",
      "repo-claude-hook",
      "repo-mcp",
      "repo-codex-mcp",
    ].map(marker),
    mounts: [
      mount(LIBRARY_SKILL, objects),
      mount(ASKED_SKILL, objects, false),
      mount(AGENTS_SKILL, join(objects, "agents")),
      member(SET_SKILL),
      member(SET_SIBLING),
    ],
  };
};

/** The hub tool the step-recording contract calls. */
export const CONTRACT_HUB_TOOL = "pip_note";

/**
 * The step-recording contract (ADR 031): a hub tool call reaches the hub with a step whose `record`
 * is the turn's `recordToolStart`, so a hub call is recorded durably before it runs, as the runtime's
 * own calls are. The hub tool records its step as the hub action pipeline does and runs only once it
 * is recorded; `order` says what happened. With `records` false, the turn refuses to record it.
 */
export const stepRecordingContract = (records = true) => {
  const order: Array<string> = [];
  const hubTools: HubTools = {
    tools: [
      {
        name: CONTRACT_HUB_TOOL,
        description: "Reads the hub's note.",
        inputSchema: { type: "object", properties: {} },
        label: "Reading the note",
      },
    ],
    call: (name, _input, step) =>
      step === undefined
        ? Effect.sync(() => {
            order.push("no step");
            return { text: UNRECORDED_TOOL_CALL, refused: true };
          })
        : step
            .record({
              _tag: "ToolStarted",
              id: step.id,
              tool: name,
              operation: "pip.read",
              targets: ["note"],
              label: "Reading the note",
            })
            .pipe(
              Effect.map((recorded) => {
                order.push(recorded ? "ran" : "not run");
                return recorded
                  ? { text: "The note says hello.", refused: false }
                  : { text: UNRECORDED_TOOL_CALL, refused: true };
              }),
            ),
  };
  const recordToolStart = (event: ToolStartedEvent) =>
    Effect.sync(() => {
      order.push(`recorded ${event.tool} as ${event.id}`);
      return records;
    });
  return { hubTools, recordToolStart, order };
};

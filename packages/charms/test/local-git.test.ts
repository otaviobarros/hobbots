import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  type ApprovalAction,
  type ApprovalOutcome,
  actionDigest,
  LocalGitTools,
  makeRedactor,
  type RuntimeEvent,
  type ToolAccess,
  type TurnApprovals,
} from "@hobbots/agents";
import {
  AgentId,
  ApprovalId,
  EMPTY_HOB_POLICY,
  GIT_INIT_TOOL,
  type PolicyDecision,
  type SafetyPreset,
} from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { LocalGitToolsLive, NEXT_TURN, PUBLISH_SCRIPT } from "../src/index.ts";

// #578: in the sandbox `git init` cannot write a new repository's config, so the hub creates the
// repository for the hob, under its policy, with Git's defaults and no hooks (ADR 014).

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hobbots-local-git-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let project = "";
let outside = "";
let count = 0;
beforeEach(() => {
  count += 1;
  project = path.join(root, `project-${count}`);
  outside = path.join(root, `outside-${count}`);
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
});

const accessFor = (
  folder: string,
  preset: SafetyPreset = "balanced",
  overrides: Partial<Record<"local-git" | "edit-files", PolicyDecision>> = {},
): ToolAccess => ({
  policy: {
    preset,
    sharedFolders: [folder],
    hob: { ...EMPTY_HOB_POLICY, overrides },
    dataFolder: path.join(root, "data"),
    restrictions: [],
  },
  folders: [folder],
  runtimeFolder: path.join(root, "runtimes", "hob"),
});

/** The user, answering every request as `answer` says, each recorded in `asked`. */
const userApprovals = (
  access: ToolAccess,
  asked: Array<ApprovalAction>,
  answer: "approve" | "deny",
): TurnApprovals => ({
  request: (action) =>
    Effect.gen(function* () {
      asked.push(action);
      const digest = yield* actionDigest(action);
      const decision: ApprovalOutcome =
        answer === "approve"
          ? { _tag: "Approved", actionDigest: digest, policyVersion: action.policyVersion, lifetime: "once" }
          : { _tag: "Denied", reason: "Not here." };
      return { approvalId: ApprovalId.make(`approval-${asked.length}`), decision: Effect.succeed(decision) };
    }),
  currentAccess: Effect.succeed(access),
  grants: Effect.succeed([]),
  used: () => Effect.void,
});

const staging = path.join(root, "hub", "local-git");
const layer = LocalGitToolsLive({ stagingFolder: staging }).pipe(
  Layer.provide(Layer.mergeAll(PolicyEngine.node, NodeServices.layer)),
);

/** One call of the tool on a turn with `access`, with a step when the user can be asked. */
const callInit = (
  access: ToolAccess | null,
  input: unknown,
  user?: { readonly asked: Array<ApprovalAction>; readonly answer: "approve" | "deny" },
) =>
  Effect.gen(function* () {
    const tools = yield* (yield* LocalGitTools).forTurn({
      agentId: AgentId.make("hob"),
      threadId: null,
      messageId: null,
      currentAccess: Effect.succeed(access),
      redactor: makeRedactor(),
      approvals: user && access ? userApprovals(access, user.asked, user.answer) : null,
    });
    if (tools === null) return { offered: false, answer: null, events: [] };
    const events: Array<RuntimeEvent> = [];
    const answer = yield* tools.call(GIT_INIT_TOOL, input, { id: "step-1", report: (event) => events.push(event) });
    return { offered: true, names: tools.tools.map((tool) => tool.name), answer, events };
  }).pipe(Effect.provide(layer), Effect.runPromise);

const gitIn = (folder: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", folder, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

describe("creating a repository for a hob", () => {
  // covers PE-005
  it("[TC-PE-324] creates a repository with Git's defaults and no hooks in a hob's folder, or a new folder inside it", async () => {
    const created = await callInit(accessFor(project), { folder: project });
    expect(created.names).toEqual([GIT_INIT_TOOL]);
    expect(created.answer).toMatchObject({ refused: false });
    expect(created.answer?.text).toContain(`Created an empty Git repository in ${project}`);
    // On Linux the running turn sees a repository at the top of a folder from its next turn (ADR 014).
    expect(created.answer?.text.includes(NEXT_TURN)).toBe(process.platform === "linux");
    expect(gitIn(project, "rev-parse", "--is-inside-work-tree")).toBe("true");
    // No template: no sample hooks, and only Git's own settings in the config.
    expect(fs.existsSync(path.join(project, ".git", "hooks"))).toBe(false);
    // The repository is made beside the folder's .git and then named .git, leaving nothing else behind.
    expect(fs.readdirSync(project)).toEqual([".git"]);
    expect(gitIn(project, "config", "--file", path.join(project, ".git", "config"), "--list")).not.toMatch(
      /hookspath|fsmonitor|alias|url\./i,
    );
    // The call shows as a step that ran, on the folder decided.
    expect(created.events).toContainEqual(
      expect.objectContaining({ _tag: "ToolStarted", tool: GIT_INIT_TOOL, operation: "local-git", targets: [project] }),
    );

    // A folder below that does not exist yet is made too.
    const nested = path.join(project, "tools", "cli");
    expect((await callInit(accessFor(project), { folder: nested })).answer).toMatchObject({ refused: false });
    expect(gitIn(nested, "rev-parse", "--show-toplevel")).toBe(nested);
  });

  // covers PE-005, PE-001
  it("[TC-PE-325] refuses a folder outside the hob's, in a Git directory, already a repository, or given relative, and creates nothing", async () => {
    const access = accessFor(project);
    const outsideAnswer = (await callInit(access, { folder: outside })).answer;
    expect(outsideAnswer).toMatchObject({ refused: true });
    expect(outsideAnswer?.text).toContain("outside this hob's folders");
    expect(fs.existsSync(path.join(outside, ".git"))).toBe(false);

    // A link inside the folder that leads outside it is outside.
    fs.symlinkSync(outside, path.join(project, "escape"));
    expect((await callInit(access, { folder: path.join(project, "escape") })).answer).toMatchObject({ refused: true });
    expect(fs.existsSync(path.join(outside, ".git"))).toBe(false);

    expect((await callInit(access, { folder: "project" })).answer?.text).toContain("absolute path");
    expect((await callInit(access, { path: project })).answer).toMatchObject({ refused: true });

    // An existing repository is left as it is, and nothing is written in its Git directory.
    gitIn(project, "init", "--quiet");
    const config = fs.readFileSync(path.join(project, ".git", "config"), "utf8");
    expect((await callInit(access, { folder: project })).answer?.text).toContain("already a Git repository");
    expect((await callInit(access, { folder: path.join(project, ".git", "hooks") })).answer?.text).toContain(
      "inside a Git directory",
    );
    expect(fs.readFileSync(path.join(project, ".git", "config"), "utf8")).toBe(config);
    expect(fs.readdirSync(path.join(project, ".git", "hooks")).some((name) => !name.endsWith(".sample"))).toBe(false);

    // A turn without folders is offered nothing.
    expect((await callInit(null, { folder: project })).offered).toBe(false);
  });

  // covers PE-001, PE-003
  it("[TC-PE-326] decides the call as Local Git under the hob's policy: Never refuses, and Careful asks first", async () => {
    const never = await callInit(accessFor(project, "balanced", { "local-git": "deny" }), { folder: project });
    expect(never.answer).toMatchObject({ refused: true });
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);

    // Careful asks; a denial creates nothing, and an approval creates it.
    const asked: Array<ApprovalAction> = [];
    const denied = await callInit(accessFor(project, "careful"), { folder: project }, { asked, answer: "deny" });
    expect(denied.answer).toMatchObject({ refused: true });
    expect(denied.answer?.text).toContain("Not here.");
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
    const approved = await callInit(accessFor(project, "careful"), { folder: project }, { asked, answer: "approve" });
    expect(approved.answer).toMatchObject({ refused: false });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ tool: GIT_INIT_TOOL, operation: "local-git", targets: [project] });
    expect(fs.existsSync(path.join(project, ".git", "HEAD"))).toBe(true);
  });

  // covers PE-001, PE-003
  it("[TC-PE-328] decides Edit files on the new .git too: Never refuses though Local Git allows, and Ask asks", async () => {
    // Balanced allows Local Git; Edit files set to Never still refuses, and writes nothing.
    const never = await callInit(accessFor(project, "balanced", { "edit-files": "deny" }), { folder: project });
    expect(never.answer).toMatchObject({ refused: true });
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
    // Local Git set to Never refuses though Edit files allows.
    const gitNever = await callInit(accessFor(project, "balanced", { "local-git": "deny" }), { folder: project });
    expect(gitNever.answer).toMatchObject({ refused: true });
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);

    // Edit files set to Ask asks once, for the call, though Local Git allows; a denial writes nothing.
    const asked: Array<ApprovalAction> = [];
    const askEdit = accessFor(project, "balanced", { "edit-files": "ask" });
    const denied = await callInit(askEdit, { folder: project }, { asked, answer: "deny" });
    expect(denied.answer).toMatchObject({ refused: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: GIT_INIT_TOOL, targets: [project] });
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
    // Without anyone to ask, the call is refused; once approved, it runs.
    expect((await callInit(askEdit, { folder: project })).answer).toMatchObject({ refused: true });
    expect(fs.existsSync(path.join(project, ".git"))).toBe(false);
    const approved = await callInit(askEdit, { folder: project }, { asked, answer: "approve" });
    expect(approved.answer).toMatchObject({ refused: false });
    expect(asked).toHaveLength(2);
    expect(fs.existsSync(path.join(project, ".git", "HEAD"))).toBe(true);
  });

  // covers PE-001, PE-005
  it("[TC-PE-329] makes the repository where no hob's command reaches, then copies it to the decided folder without following links, below the hub's own folder too", async () => {
    // Below the hub's working folder, where sandbox-runtime keeps every .git/config read-only for a sandbox.
    const beneathHub = fs.realpathSync(fs.mkdtempSync(path.join(import.meta.dirname, ".local-git-")));
    try {
      expect(beneathHub.startsWith(`${fs.realpathSync(process.cwd())}${path.sep}`)).toBe(true);
      expect((await callInit(accessFor(beneathHub), { folder: beneathHub })).answer).toMatchObject({ refused: false });
      expect(gitIn(beneathHub, "rev-parse", "--show-toplevel")).toBe(beneathHub);
      expect(gitIn(beneathHub, "config", "--local", "core.bare")).toBe("false");
      expect(fs.readdirSync(beneathHub)).toEqual([".git"]);
    } finally {
      fs.rmSync(beneathHub, { recursive: true, force: true });
    }
    // Git made it in the hub's own staging folder, outside the hob's folders, and nothing is left there.
    expect(fs.readdirSync(staging)).toEqual([]);

    // The copy binds to the folder decided: a level, or .git, laid as a link after the decision leads nowhere.
    const made = path.join(root, `made-${count}`);
    execFileSync("git", ["init", "--quiet", "--template=", made]);
    const publish = (levels: Array<string>) =>
      (() => {
        try {
          execFileSync(
            process.execPath,
            ["-e", PUBLISH_SCRIPT, JSON.stringify([project, levels, path.join(made, ".git")])],
            {
              encoding: "utf8",
            },
          );
          return { code: 0, out: "" };
        } catch (error) {
          const failed = error as { status: number; stdout: string };
          return { code: failed.status, out: failed.stdout };
        }
      })();
    fs.symlinkSync(outside, path.join(project, "swapped"));
    expect(publish(["swapped", "app"])).toMatchObject({ code: 3, out: expect.stringContaining("moved") });
    fs.symlinkSync(outside, path.join(project, ".git"));
    expect(publish([])).toMatchObject({ code: 4, out: expect.stringContaining("already has a .git") });
    expect(fs.readdirSync(outside)).toEqual([]);
    // Into a folder it holds, it copies Git's files and nothing else.
    expect(publish(["app"])).toMatchObject({ code: 0 });
    expect(gitIn(path.join(project, "app"), "rev-parse", "--show-toplevel")).toBe(path.join(project, "app"));
    expect(fs.readdirSync(path.join(project, "app", ".git")).sort()).toEqual(
      fs.readdirSync(path.join(made, ".git")).sort(),
    );
  });
});

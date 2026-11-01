import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import type { HubTools, RuntimeEvent } from "@hobbots/agents";
import { EMPTY_HOB_POLICY, TASK_TOOLS, taskToolJsonSchema } from "@hobbots/domain";
import { PolicyEngine } from "@hobbots/permissions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { policyHooks, toolTurn } from "../src/claude-code.ts";
import { HUB_SERVER, hubToolOf, inputShape, withHubTools } from "../src/hub-tools.ts";

const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
const hub: HubTools = {
  tools: TASK_TOOLS.map((tool) => ({ ...tool, inputSchema: taskToolJsonSchema(tool.name) })),
  call: (name, input) =>
    Effect.sync(() => {
      calls.push({ name, input });
      return name === "ask" ? { text: "Refused (not-owner): no", refused: true } : { text: "Planned", refused: false };
    }),
};

const signal = new AbortController().signal;
const base = { session_id: "s", transcript_path: "", cwd: "/", tool_input: {}, tool_use_id: "t1" };

describe("hub tools on Claude Code's control channel", () => {
  it("advertises each tool's input as the hub's JSON Schema describes it", () => {
    for (const tool of TASK_TOOLS) {
      const shape = inputShape(taskToolJsonSchema(tool.name));
      const advertised = z.toJSONSchema(z.object(shape)) as { required?: ReadonlyArray<string> };
      const wanted = taskToolJsonSchema(tool.name) as { required?: ReadonlyArray<string> };
      expect(advertised.required ?? [], tool.name).toEqual(wanted.required ?? []);
    }
    const plan = z.object(inputShape(taskToolJsonSchema("plan_steps")));
    expect(plan.safeParse({ key: "k", steps: [{ brief: "Research" }] }).success).toBe(true);
    expect(plan.safeParse({ key: "k" }).success).toBe(false);
  });

  it("tells hub tools apart from every other tool", () => {
    expect(hubToolOf(`mcp__${HUB_SERVER}__plan_steps`)).toBe("plan_steps");
    expect(hubToolOf("mcp__other__plan_steps")).toBeNull();
    expect(hubToolOf("Bash")).toBeNull();
  });

  it("serves the tools, allows them by name and shows each call as a step", async () => {
    const chatOnly: Options = { tools: [], disallowedTools: ["*"], permissionMode: "dontAsk" };
    expect(withHubTools(chatOnly, null, () => {})).toBe(chatOnly);
    const events: Array<RuntimeEvent> = [];
    const options = withHubTools(chatOnly, hub, (event) => events.push(event));
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools).toEqual(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools).toEqual(TASK_TOOLS.map((tool) => `mcp__${HUB_SERVER}__${tool.name}`));
    expect(Object.keys(options.mcpServers ?? {})).toEqual([HUB_SERVER]);

    const name = `mcp__${HUB_SERVER}__delegate_task`;
    const [pre] = options.hooks?.PreToolUse ?? [];
    const [post] = options.hooks?.PostToolUse ?? [];
    expect(new RegExp(pre?.matcher ?? "").test(name)).toBe(true);
    await pre?.hooks[0]?.({ ...base, tool_name: name, hook_event_name: "PreToolUse" } as HookInput, "t1", { signal });
    await post?.hooks[0]?.(
      { ...base, tool_name: name, hook_event_name: "PostToolUse", tool_response: "" } as HookInput,
      "t1",
      { signal },
    );
    expect(events).toEqual([
      { _tag: "StepStarted", id: "t1", kind: "tool", label: "Delegating a Task" },
      { _tag: "StepEnded", id: "t1" },
    ]);
  });

  it("answers a call with the hub's text, as an error when the hub refused it", async () => {
    const options = withHubTools({}, hub, () => {});
    const server = options.mcpServers?.[HUB_SERVER];
    expect(server?.type).toBe("sdk");
    // The registered handlers are what Claude Code's MCP requests reach.
    const registered = (
      server as unknown as {
        instance: {
          _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
        };
      }
    ).instance._registeredTools;
    expect(Object.keys(registered)).toEqual(TASK_TOOLS.map((tool) => tool.name));
    calls.length = 0;
    expect(await registered.plan_steps?.handler({ key: "k", steps: [{ brief: "x" }] }, {})).toEqual({
      content: [{ type: "text", text: "Planned" }],
      isError: false,
    });
    expect(await registered.ask?.handler({ key: "k", question: "?" }, {})).toEqual({
      content: [{ type: "text", text: "Refused (not-owner): no" }],
      isError: true,
    });
    expect(calls).toEqual([
      { name: "plan_steps", input: { key: "k", steps: [{ brief: "x" }] } },
      { name: "ask", input: { key: "k", question: "?" } },
    ]);
  });

  it("keeps the policy hook out of hub tool calls, which the hub decides", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-hub-")));
    const project = join(root, "project");
    mkdirSync(project);
    const engine = await Effect.runPromise(Effect.service(PolicyEngine).pipe(Effect.provide(PolicyEngine.node)));
    const turn = toolTurn(
      {
        policy: {
          preset: "balanced",
          sharedFolders: [project],
          hob: EMPTY_HOB_POLICY,
          dataFolder: join(root, "data"),
          restrictions: [],
        },
        folders: [project],
        runtimeFolder: join(root, "runtimes"),
      },
      "on",
    );
    if (turn === null) throw new Error("expected a tool turn");
    const events: Array<RuntimeEvent> = [];
    const { hooks } = policyHooks(engine, turn, (event) => events.push(event));
    const [pre] = hooks.PreToolUse?.[0]?.hooks ?? [];
    const answer = await pre?.(
      {
        ...base,
        cwd: project,
        tool_name: `mcp__${HUB_SERVER}__plan_steps`,
        hook_event_name: "PreToolUse",
      } as HookInput,
      "t1",
      { signal },
    );
    expect(answer).toEqual({});
    expect(events).toEqual([]);
    // Any other MCP tool stays unknown, so it is refused.
    const other = await pre?.(
      { ...base, cwd: project, tool_name: "mcp__other__plan_steps", hook_event_name: "PreToolUse" } as HookInput,
      "t2",
      { signal },
    );
    expect(other).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

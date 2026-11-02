import {
  createSdkMcpServer,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { HubTools, RuntimeEvent } from "@hobbots/agents";
import { Effect } from "effect";
import { z } from "zod";

/** The MCP server Hobbots' own tools are served as, on Claude Code's control channel (ADR 018). */
export const HUB_SERVER = "hobbots";

const PREFIX = `mcp__${HUB_SERVER}__`;

/** The hub tool a Claude Code tool name calls, or null for any other tool. */
export const hubToolOf = (tool: string): string | null => (tool.startsWith(PREFIX) ? tool.slice(PREFIX.length) : null);

/**
 * The input a tool advertises, as the raw shape the Agent SDK takes. The JSON Schema is the hub's,
 * converted with Zod; the hub decodes every input again, so the conversion only informs the model.
 */
export const inputShape = (schema: Readonly<Record<string, unknown>>): z.ZodRawShape => {
  const converted = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  return converted instanceof z.ZodObject ? converted.shape : {};
};

/** The in-process MCP server that answers the turn's hub tool calls through the hub. */
const hubServer = (hub: HubTools) =>
  createSdkMcpServer({
    name: HUB_SERVER,
    alwaysLoad: true,
    tools: hub.tools.map(
      (tool): SdkMcpToolDefinition => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputShape(tool.inputSchema),
        handler: async (args) => {
          const answer = await Effect.runPromise(hub.call(tool.name, args));
          return { content: [{ type: "text", text: answer.text }], isError: answer.refused };
        },
      }),
    ),
  });

/**
 * Claude Code's options for a turn that offers hub tools: the server, and hooks that approve each
 * call to its tools (the hub decides each call, not the policy hook) and show it as a step.
 * Built-in tools stay as the rest of the options set them.
 *
 * The hook approves the calls rather than bare `allowedTools` entries, which would shadow the
 * permission callback and make the Agent SDK warn on every tool turn (#329). Hook approval holds
 * in `default` and `dontAsk` mode; a call that lost it reaches the callback, which refuses a tool
 * it does not know.
 */
const hubOptions = (hub: HubTools, report: (event: RuntimeEvent) => void): Partial<Options> => {
  const labels = new Map(hub.tools.map((tool) => [tool.name, tool.label]));
  const started = new Set<string>();
  const start: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const name = hubToolOf(input.tool_name);
    const label = name === null ? undefined : labels.get(name);
    if (label === undefined) return {};
    started.add(input.tool_use_id);
    report({ _tag: "StepStarted", id: input.tool_use_id, kind: "tool", label });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Hobbots decides its own tools' calls.",
      },
    };
  };
  const end: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    if (started.delete(input.tool_use_id)) report({ _tag: "StepEnded", id: input.tool_use_id });
    return {};
  };
  const matcher = `${PREFIX}.*`;
  return {
    mcpServers: { [HUB_SERVER]: hubServer(hub) },
    strictMcpConfig: true,
    hooks: {
      PreToolUse: [{ matcher, hooks: [start] }],
      PostToolUse: [{ matcher, hooks: [end] }],
      PostToolUseFailure: [{ matcher, hooks: [end] }],
    },
  };
};

/** Both sets of hooks, each event's in order. */
const mergeHooks = (
  first: Options["hooks"],
  second: Options["hooks"],
): Partial<Record<HookEvent, Array<HookCallbackMatcher>>> => {
  const merged: Partial<Record<HookEvent, Array<HookCallbackMatcher>>> = { ...first };
  for (const [event, matchers] of Object.entries(second ?? {}) as Array<[HookEvent, Array<HookCallbackMatcher>]>) {
    merged[event] = [...(merged[event] ?? []), ...matchers];
  }
  return merged;
};

/** Tools Claude Code adds once any MCP server is present; the hub's server offers no resources. */
const MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"];

/**
 * A turn's options with its hub tools added. A chat-only turn closes every tool with `*`, which
 * would close the hub's too, so it closes the MCP resource tools by name instead: it offers no
 * built-in tool and the hook approves only the hub's.
 */
export const withHubTools = (
  options: Options,
  hub: HubTools | null | undefined,
  report: (event: RuntimeEvent) => void,
): Options => {
  if (!hub || hub.tools.length === 0) return options;
  const added = hubOptions(hub, report);
  return {
    ...options,
    ...added,
    disallowedTools: [...(options.disallowedTools ?? []).filter((rule) => rule !== "*"), ...MCP_RESOURCE_TOOLS],
    hooks: mergeHooks(options.hooks, added.hooks),
  };
};

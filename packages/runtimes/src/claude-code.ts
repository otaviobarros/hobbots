import { mkdirSync } from "node:fs";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeHealth } from "@hobbots/domain";
import { DateTime, Effect, Layer, Stream } from "effect";
import { type PromptRequest, RuntimeAdapter, RuntimeError, type RuntimeEvent } from "./adapter.ts";

export interface ClaudeCodeConfig {
  /** Empty working folder the runtime is confined to. */
  readonly workspaceDir: string;
  /** Claude Code binary to run; the SDK finds its platform package's binary when unset. */
  readonly executable?: string | undefined;
}

/**
 * Reports where requests are billed, from the SDK's own credential fields.
 * Only a claude.ai login (no API key, a Pro/Max/Team plan) counts as the subscription.
 */
export const billingFrom = (apiKeySource: string | undefined, subscriptionType?: string): string => {
  if (apiKeySource !== undefined && apiKeySource !== "none") return `api-key (${apiKeySource})`;
  if (subscriptionType === undefined) return "subscription";
  if (subscriptionType === "Claude API") return "api (Claude API)";
  return `subscription (${subscriptionType})`;
};

// Chat-only until the permission broker exists: no built-in tools, nothing auto-approved,
// no user/project settings or MCP servers loaded from disk.
// ANTHROPIC_API_KEY is removed so Claude Code always uses the claude.ai login (the subscription).
const baseOptions = (config: ClaudeCodeConfig): Options => ({
  cwd: config.workspaceDir,
  ...(config.executable === undefined ? {} : { pathToClaudeCodeExecutable: config.executable }),
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_AGENT_SDK_CLIENT_APP: "hobbots",
  },
  tools: [],
  disallowedTools: ["*"],
  permissionMode: "dontAsk",
  settingSources: [],
});

const toEvents = (message: SDKMessage): ReadonlyArray<RuntimeEvent> => {
  switch (message.type) {
    case "system":
      return message.subtype === "init"
        ? [
            {
              _tag: "SessionStarted",
              sessionId: message.session_id,
              billing: billingFrom(message.apiKeySource),
            },
          ]
        : [];
    case "stream_event": {
      const event = message.event;
      if (
        message.parent_tool_use_id === null &&
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        return [{ _tag: "TextDelta", text: event.delta.text }];
      }
      return [];
    }
    case "result":
      if (message.subtype !== "success" || message.is_error) {
        throw new RuntimeError({
          message: message.subtype === "success" ? message.result : `Claude Code turn ended: ${message.subtype}`,
        });
      }
      return [
        {
          _tag: "Completed",
          sessionId: message.session_id,
          text: message.result,
        },
      ];
    default:
      return [];
  }
};

const errorMessage = (error: unknown) =>
  error instanceof RuntimeError
    ? error
    : new RuntimeError({
        message: error instanceof Error ? error.message : String(error),
      });

export const makeClaudeCode = (config: ClaudeCodeConfig) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => mkdirSync(config.workspaceDir, { recursive: true }));

    const sendPrompt = (request: PromptRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const abortController = new AbortController();
          const turn = yield* Effect.acquireRelease(
            Effect.sync(() =>
              query({
                prompt: request.prompt,
                options: {
                  ...baseOptions(config),
                  abortController,
                  includePartialMessages: true,
                  systemPrompt: {
                    type: "preset",
                    preset: "claude_code",
                    append: request.instructions,
                  },
                  ...(request.sessionId ? { resume: request.sessionId } : {}),
                  ...(request.model ? { model: request.model } : {}),
                },
              }),
            ),
            (turn) =>
              Effect.sync(() => {
                abortController.abort();
                turn.close();
              }),
          );
          return Stream.fromAsyncIterable(turn, errorMessage).pipe(
            Stream.mapEffect((message) => Effect.try({ try: () => toEvents(message), catch: errorMessage })),
            Stream.flattenIterable,
          );
        }),
      );

    // Starts Claude Code without sending a prompt, so the check costs no usage.
    const health = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.tryPromise({
        try: async () => {
          const idle: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise(() => {}),
            }),
          };
          const probe = query({ prompt: idle, options: baseOptions(config) });
          try {
            const [account, init] = await Promise.all([probe.accountInfo(), probe.initializationResult()]);
            return new RuntimeHealth({
              runtime: "claude-code",
              availability: "ready",
              billing: billingFrom(account.apiKeySource, account.subscriptionType),
              version: "claude_code_version" in init ? String(init.claude_code_version) : null,
              detail: account.email ?? null,
              checkedAt,
            });
          } finally {
            probe.close();
          }
        },
        catch: errorMessage,
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catch((error) =>
          Effect.succeed(
            new RuntimeHealth({
              runtime: "claude-code",
              availability: "unavailable",
              billing: null,
              version: null,
              detail: "message" in error ? String(error.message) : "Claude Code did not respond",
              checkedAt,
            }),
          ),
        ),
      );
    });

    return RuntimeAdapter.of({ health, sendPrompt });
  });

export const ClaudeCodeLayer = (config: ClaudeCodeConfig) => Layer.effect(RuntimeAdapter, makeClaudeCode(config));

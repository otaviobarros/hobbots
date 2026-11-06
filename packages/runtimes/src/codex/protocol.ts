/**
 * The parts of the Codex App Server protocol Hobbots speaks (ADR 024).
 *
 * Copied from `codex app-server generate-ts --experimental` of Codex 0.166.0, the minimum version
 * Hobbots runs, and trimmed to the fields Hobbots reads. Raising the minimum version means
 * generating the types again and comparing them with these.
 */

/** A JSON-RPC request ID. Codex answers with the ID it was sent. */
export type RequestId = string | number;

interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** One line of the App Server's output: a response, a notification or a request to the client. */
export interface JsonRpcMessage {
  readonly id?: RequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

interface ClientInfo {
  readonly name: string;
  readonly title: string | null;
  readonly version: string;
}

interface InitializeParams {
  readonly clientInfo: ClientInfo;
  readonly capabilities: {
    /** Dynamic tools and other experimental methods need it (ADR 024). */
    readonly experimentalApi: boolean;
    readonly optOutNotificationMethods?: ReadonlyArray<string> | null;
  } | null;
}

export interface InitializeResponse {
  readonly userAgent: string;
  /** Absolute path to the server's `CODEX_HOME`. */
  readonly codexHome: string;
  readonly platformFamily: string;
  readonly platformOs: string;
}

/** ChatGPT plans, as Codex names them; a newer Codex may add more. */
type PlanType = string;

/** How Codex is signed in. Only `chatgpt` runs hobs (ADR 024). */
export type Account =
  | { readonly type: "apiKey" }
  | {
      readonly type: "chatgpt";
      readonly email: string | null;
      readonly planType: PlanType;
      readonly workspaceName: string | null;
    }
  | { readonly type: "amazonBedrock"; readonly usesCodexManagedCredentials: boolean }
  | { readonly type: "gcp" };

interface GetAccountParams {
  /** Asks Codex to refresh its login first. Health checks never do. */
  readonly refreshToken?: boolean;
}

interface WorkspaceRouting {
  /** The ChatGPT workspace the sign-in uses. */
  readonly chatgptAccountId: string;
  readonly backendOrigin: string;
}

export interface GetAccountResponse {
  readonly account: Account | null;
  readonly requiresOpenaiAuth: boolean;
  readonly workspaceRouting: WorkspaceRouting | null;
}

type AuthMode =
  | "apikey"
  | "chatgpt"
  | "chatgptAuthTokens"
  | "headers"
  | "agentIdentity"
  | "personalAccessToken"
  | "bedrockApiKey"
  | "bedrockAccessKeys";

interface GetAuthStatusParams {
  readonly includeToken: boolean | null;
  readonly refreshToken: boolean | null;
}

interface GetAuthStatusResponse {
  readonly authMethod: AuthMode | null;
  /** Only with `includeToken`. Hobbots asks for it only to sign a turn in, never for health. */
  readonly authToken: string | null;
  readonly requiresOpenaiAuth: boolean | null;
}

interface ModelListParams {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly includeHidden?: boolean | null;
}

interface ReasoningEffortOption {
  /** Codex's effort name, such as "low" or "ultra"; a newer Codex may add more. */
  readonly reasoningEffort: string;
  readonly description: string;
}

export interface Model {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<ReasoningEffortOption>;
  readonly defaultReasoningEffort: string;
  readonly inputModalities: ReadonlyArray<"text" | "image" | "audio">;
  readonly isDefault: boolean;
}

export interface ModelListResponse {
  readonly data: ReadonlyArray<Model>;
  /** Pass it back to read the next page; null on the last one. */
  readonly nextCursor: string | null;
}

/** One window of a plan's limit. */
export interface RateLimitWindow {
  /** How much of the window is used, 0 to 100. */
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  /** When the window refills, in seconds since the epoch. */
  readonly resetsAt: number | null;
}

/** One of the plan's metered limits, such as `codex`, with its two windows. */
export interface RateLimitSnapshot {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RateLimitWindow | null;
  readonly secondary: RateLimitWindow | null;
  readonly rateLimitReachedType: string | null;
}

interface GetAccountRateLimitsParams {
  /** Skips the reset-credit details, which Hobbots does not show. */
  readonly excludeResetCreditDetails?: boolean;
}

export interface GetAccountRateLimitsResponse {
  /** The single-limit view, kept for older clients. */
  readonly rateLimits: RateLimitSnapshot;
  /** Every metered limit by its `limitId`, when Codex reports more than one. */
  readonly rateLimitsByLimitId: Readonly<Record<string, RateLimitSnapshot | undefined>> | null;
}

/**
 * The client requests Hobbots sends, by method, with their parameters and results. A request's
 * types come from here, so a method missing from this map cannot be sent.
 */
export interface ClientRequests {
  readonly initialize: { readonly params: InitializeParams; readonly result: InitializeResponse };
  readonly "account/read": { readonly params: GetAccountParams; readonly result: GetAccountResponse };
  readonly getAuthStatus: { readonly params: GetAuthStatusParams; readonly result: GetAuthStatusResponse };
  readonly "model/list": { readonly params: ModelListParams; readonly result: ModelListResponse };
  readonly "account/rateLimits/read": {
    readonly params: GetAccountRateLimitsParams;
    readonly result: GetAccountRateLimitsResponse;
  };
  readonly "account/login/start": { readonly params: ChatgptAuthTokensLogin; readonly result: unknown };
  readonly "thread/start": { readonly params: ThreadStartParams; readonly result: ThreadStartResponse };
  readonly "thread/resume": { readonly params: ThreadResumeParams; readonly result: ThreadResumeResponse };
  readonly "turn/start": { readonly params: TurnStartParams; readonly result: TurnStartResponse };
  readonly "turn/interrupt": { readonly params: TurnInterruptParams; readonly result: unknown };
  readonly "turn/steer": { readonly params: TurnSteerParams; readonly result: TurnSteerResponse };
}

// Turns (#438): threads, turns, the notifications a turn reads and the requests Codex sends it.

/** How often Codex asks the client. Hobbots always asks about every call (ADR 024). */
type AskForApproval = "untrusted" | "on-request" | "never";

/** Codex's own sandbox. Hobbots turns it off inside its own (ADR 024). */
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

type SandboxPolicy =
  | { readonly type: "dangerFullAccess" }
  | { readonly type: "externalSandbox"; readonly networkAccess: "restricted" | "enabled" };

/**
 * A hub tool the thread offers, which Codex calls back as `item/tool/call` (ADR 024). Codex keeps the
 * tools a thread started with; `thread/resume` takes none.
 */
export interface DynamicToolSpec {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** A call to a hub tool, which the client runs and answers. `callId` is also the call's item ID. */
export interface DynamicToolCallParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

/** The answer to a hub tool call, as the model reads it. A refused call is answered with `success: false`. */
export interface DynamicToolCallResponse {
  readonly contentItems: ReadonlyArray<{ readonly type: "inputText"; readonly text: string }>;
  readonly success: boolean;
}

interface ThreadSettings {
  readonly cwd?: string | null;
  readonly approvalPolicy?: AskForApproval | null;
  readonly sandbox?: SandboxMode | null;
  readonly model?: string | null;
  /** Settings for this thread only, as `config.toml` keys. */
  readonly config?: Readonly<Record<string, unknown>> | null;
}

interface ThreadStartParams extends ThreadSettings {
  /** Kept for the thread's life: a resumed thread ignores new ones (ADR 024). */
  readonly developerInstructions?: string | null;
  readonly dynamicTools?: ReadonlyArray<DynamicToolSpec> | null;
  /** Kept in memory only: Codex saves no rollout of the thread, so it can never be resumed or listed. */
  readonly ephemeral?: boolean | null;
}

interface ThreadResumeParams extends ThreadSettings {
  readonly threadId: string;
  /** Leaves the earlier turns out of the answer; the thread keeps them. */
  readonly excludeTurns?: boolean;
}

interface Thread {
  /** The thread's ID, which Hobbots keeps as the Hobbots thread's Codex session. */
  readonly id: string;
}

interface ThreadStartResponse {
  readonly thread: Thread;
  readonly model: string;
}

type ThreadResumeResponse = ThreadStartResponse;

interface UserInputText {
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}

interface TurnStartParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<UserInputText>;
  readonly approvalPolicy?: AskForApproval | null;
  readonly sandboxPolicy?: SandboxPolicy | null;
  readonly model?: string | null;
  /** Codex's effort name, such as "high". */
  readonly effort?: string | null;
}

type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/** Codex's error kind; only a reached usage limit is told apart. A newer Codex may add more. */
type CodexErrorInfo = "usageLimitExceeded" | string | Readonly<Record<string, unknown>>;

export interface TurnError {
  readonly message: string;
  readonly codexErrorInfo: CodexErrorInfo | null;
  readonly additionalDetails: string | null;
}

export interface Turn {
  readonly id: string;
  readonly status: TurnStatus;
  /** Why a failed or interrupted turn ended. */
  readonly error: TurnError | null;
}

export interface TurnStartResponse {
  readonly turn: Turn;
}

/**
 * Input added to the turn that is running, which the model reads with its next request. Codex refuses
 * it when `expectedTurnId` is not the running turn.
 */
interface TurnSteerParams {
  readonly threadId: string;
  readonly input: ReadonlyArray<UserInputText>;
  readonly expectedTurnId: string;
}

interface TurnSteerResponse {
  readonly turnId: string;
}

interface TurnInterruptParams {
  readonly threadId: string;
  readonly turnId: string;
}

/** Codex's external sign-in mode: the token stays in memory and no `auth.json` is written (ADR 024). */
interface ChatgptAuthTokensLogin {
  readonly type: "chatgptAuthTokens";
  readonly accessToken: string;
  /** The ChatGPT workspace the token is for. */
  readonly chatgptAccountId: string;
  readonly chatgptPlanType?: string | null;
}

/** How a patch changes a file: adds, deletes, or updates it, and moves it when `move_path` is set. */
type PatchChangeKind =
  | { readonly type: "add" }
  | { readonly type: "delete" }
  | { readonly type: "update"; readonly move_path: string | null };

/** One file a patch changes, by its absolute path, and the change as a diff. */
export interface FileUpdateChange {
  readonly path: string;
  readonly kind: PatchChangeKind;
  readonly diff: string;
}

type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

/** An item of a turn, trimmed to the kinds and fields Hobbots reads. */
export type ThreadItem =
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string }
  | {
      readonly type: "commandExecution";
      readonly id: string;
      readonly command: string;
      readonly cwd: string;
      readonly status: CommandExecutionStatus;
      /** What the command printed, stdout and stderr together. */
      readonly aggregatedOutput: string | null;
      readonly exitCode: number | null;
    }
  | {
      readonly type: "fileChange";
      readonly id: string;
      readonly changes: ReadonlyArray<FileUpdateChange>;
      readonly status: CommandExecutionStatus;
    }
  | {
      readonly type: "mcpToolCall";
      readonly id: string;
      readonly status: "inProgress" | "completed" | "failed";
      readonly result: unknown;
      readonly error: unknown;
    }
  | { readonly type: "dynamicToolCall"; readonly id: string; readonly status: "inProgress" | "completed" | "failed" }
  | { readonly type: "userMessage" | "plan" | "webSearch" | "imageView" | "contextCompaction"; readonly id: string };

export interface TokenUsageBreakdown {
  readonly totalTokens: number;
  /** Input tokens, cached input included. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

interface InTurn {
  readonly threadId: string;
  readonly turnId: string;
}

/** The notifications a turn reads. Others arrive too and are left out. */
export type TurnNotification =
  | { readonly method: "turn/started"; readonly params: { readonly threadId: string; readonly turn: Turn } }
  | { readonly method: "turn/completed"; readonly params: { readonly threadId: string; readonly turn: Turn } }
  | { readonly method: "item/started"; readonly params: InTurn & { readonly item: ThreadItem } }
  | { readonly method: "item/completed"; readonly params: InTurn & { readonly item: ThreadItem } }
  | {
      readonly method: "item/agentMessage/delta" | "item/commandExecution/outputDelta";
      readonly params: InTurn & { readonly itemId: string; readonly delta: string };
    }
  | {
      readonly method: "thread/tokenUsage/updated";
      readonly params: InTurn & {
        /** `last` is the latest model request's, `total` the thread's so far. */
        readonly tokenUsage: { readonly last: TokenUsageBreakdown; readonly total: TokenUsageBreakdown };
      };
    }
  | {
      readonly method: "error";
      readonly params: InTurn & { readonly error: TurnError; readonly willRetry: boolean };
    };

/** The requests Codex sends a turn's client, which Hobbots answers. Others are refused. */
export type TurnServerRequest =
  | {
      readonly method: "item/commandExecution/requestApproval";
      readonly params: InTurn & {
        /** `writeStdin` asks to type into a command already running. */
        readonly kind?: "command" | "writeStdin";
        readonly itemId: string;
        /** The command line as Codex runs it, wrapped in the user's shell (`/bin/bash -lc '…'`). */
        readonly command?: string | null;
        readonly cwd?: string | null;
      };
    }
  | { readonly method: "item/fileChange/requestApproval"; readonly params: InTurn & { readonly itemId: string } }
  | {
      readonly method: "mcpServer/elicitation/request";
      readonly params: { readonly threadId: string; readonly turnId: string | null; readonly serverName: string };
    }
  | { readonly method: "item/tool/call"; readonly params: DynamicToolCallParams }
  | {
      readonly method: "account/chatgptAuthTokens/refresh";
      readonly params: { readonly reason: "unauthorized"; readonly previousAccountId?: string | null };
    };

/** The methods of `TurnServerRequest`, which a turn's App Server is given handlers for. */
export const TURN_SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "mcpServer/elicitation/request",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
] as const satisfies ReadonlyArray<TurnServerRequest["method"]>;

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

/**
 * The client requests Hobbots sends, by method, with their parameters and results. A request's
 * types come from here, so a method missing from this map cannot be sent.
 */
export interface ClientRequests {
  readonly initialize: { readonly params: InitializeParams; readonly result: InitializeResponse };
  readonly "account/read": { readonly params: GetAccountParams; readonly result: GetAccountResponse };
  readonly getAuthStatus: { readonly params: GetAuthStatusParams; readonly result: GetAuthStatusResponse };
  readonly "model/list": { readonly params: ModelListParams; readonly result: ModelListResponse };
}

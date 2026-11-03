import { Effect } from "effect";
import { type AppServer, AppServerError } from "./app-server.ts";
import type { GetAccountResponse } from "./protocol.ts";

/**
 * How Codex is signed in, as provider health shows it. Only a ChatGPT sign-in runs hobs (ADR 024):
 * an API key, Amazon Bedrock or Google Cloud is refused like a missing sign-in.
 */
export type CodexSignIn =
  | { readonly _tag: "ChatGpt"; readonly plan: string; readonly email: string | null }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "NotChatGpt"; readonly kind: "api-key" | "amazon-bedrock" | "google-cloud" };

const otherKinds = { apiKey: "api-key", amazonBedrock: "amazon-bedrock", gcp: "google-cloud" } as const;

/** What `account/read` says about the sign-in. It never carries a token. */
export const signInOf = (response: GetAccountResponse): CodexSignIn => {
  const account = response.account;
  if (account === null) return { _tag: "SignedOut" };
  if (account.type === "chatgpt") return { _tag: "ChatGpt", plan: account.planType, email: account.email };
  return { _tag: "NotChatGpt", kind: otherKinds[account.type] };
};

/** Where requests are billed, in the words provider health uses for Claude Code. */
export const billingOf = (signIn: CodexSignIn): string | null => {
  switch (signIn._tag) {
    case "ChatGpt":
      return `subscription (${signIn.plan})`;
    case "NotChatGpt":
      return signIn.kind;
    case "SignedOut":
      return null;
  }
};

/** Reads the sign-in without refreshing it, so a health check never changes the user's login. */
export const readSignIn = (server: AppServer) =>
  server.request("account/read", { refreshToken: false }).pipe(Effect.map(signInOf));

/** What a turn's App Server is signed in with, through `account/login/start` (ADR 024). */
export interface ChatGptTokens {
  readonly accessToken: string;
  /** The ChatGPT workspace, which `chatgptAuthTokens` calls `chatgptAccountId`. */
  readonly chatgptAccountId: string;
  readonly chatgptPlanType: string | null;
}

/**
 * A fresh access token for a turn, from the hub's App Server outside the sandbox, which refreshes
 * the user's login itself so the refresh token never enters the sandbox (ADR 024). The workspace
 * comes from `account/read`'s workspace routing. Not yet verified with a real ChatGPT sign-in.
 */
export const chatGptTokens = (server: AppServer): Effect.Effect<ChatGptTokens, AppServerError> =>
  Effect.gen(function* () {
    const status = yield* server.request("getAuthStatus", { includeToken: true, refreshToken: true });
    const account = yield* server.request("account/read", { refreshToken: false });
    const signIn = signInOf(account);
    const workspace = account.workspaceRouting?.chatgptAccountId;
    if (signIn._tag !== "ChatGpt" || status.authToken === null || workspace === undefined) {
      return yield* new AppServerError({ message: "Codex is not signed in with ChatGPT. Run `codex login`." });
    }
    return { accessToken: status.authToken, chatgptAccountId: workspace, chatgptPlanType: signIn.plan };
  });

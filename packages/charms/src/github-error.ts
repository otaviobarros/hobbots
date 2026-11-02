import { Schema } from "effect";

/** Why a read failed, in words for the hob and the person. */
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  reason: Schema.Literals(["signed-out", "not-found", "rate-limited", "failed"]),
  message: Schema.String,
}) {}

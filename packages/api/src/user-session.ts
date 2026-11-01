import { Context, Schema } from "effect";
import { HttpApiMiddleware } from "effect/http-api";

/**
 * The person using Hobbots, behind a request that decides approvals or manages grants (PE-006,
 * ADR 015). Only the hub's user-session middleware provides it, so a hob, a Charm or a runtime
 * tool has no way to decide a request, save a grant or remove one: the services that do require it.
 *
 * Until device tokens exist (deployment contract), a user session is a browser client of the hub
 * itself: a request from the hub's own web client or an allowed client origin. A sandboxed hob
 * never reaches the hub's address at all (ADR 014).
 */
export class UserSession extends Context.Service<
  UserSession,
  {
    /** The client origin the request came from. */
    readonly origin: string;
  }
>()("@hobbots/api/UserSession") {}

/** A request that is not from a user session, refused before any decision or grant route runs. */
export class UserSessionRequired extends Schema.TaggedError<UserSessionRequired>()(
  "UserSessionRequired",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/**
 * Admits only user sessions to a route and provides `UserSession` to it. The approvals and grants
 * groups carry it on every route. A route elsewhere that decides or revokes needs it too, since the
 * services it would call require `UserSession` and nothing else provides one.
 */
export class UserSessionOnly extends HttpApiMiddleware.Service<UserSessionOnly, { provides: UserSession }>()(
  "@hobbots/api/UserSessionOnly",
  { error: UserSessionRequired },
) {}

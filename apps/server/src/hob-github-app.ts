import { createHash } from "node:crypto";
import {
  AgentNotFound,
  GitHubUnreachable,
  HobbotsApi,
  HobGitHubAppRefused,
  type HobGitHubAppStatus,
} from "@hobbots/api";
import { HOB_APP_CALLBACK_PATH, HOB_APP_NEW_PATH, type HobAppRefused, HobGitHubAppService } from "@hobbots/charms";
import type { AgentId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { DeviceGate } from "./devices.ts";
import { isLoopbackHost } from "./web.ts";

/**
 * A hob's own GitHub App (#223, ADR 022): the API the hob's Charms tab calls, and the two hub pages
 * the user's default browser opens without a device: the one that posts the manifest to GitHub,
 * and the callback GitHub redirects to. Both pages answer only a local request with a live, unused
 * state, and `404` otherwise.
 */

/** What a hub without the GitHub Charm, as in tests, answers. */
const NONE: HobGitHubAppStatus = { _tag: "None", cannotCreate: "no-keychain" };

const notLocal = new HobGitHubAppRefused({
  reason: "not-local",
  message: "Give a hob its own GitHub app from the hub's computer, where GitHub can send you back to the hub.",
});

const refusal = (agentId: AgentId) => (refused: HobAppRefused) =>
  refused.reason === "not-found"
    ? new AgentNotFound({ agentId })
    : new HobGitHubAppRefused({ reason: refused.reason, message: refused.message });

/** The hub at its loopback address and the port the request reached, where GitHub redirects. */
const hubUrlOf = (request: HttpServerRequest.HttpServerRequest) => {
  const host = request.headers.host;
  if (!isLoopbackHost(host)) return null;
  const port = new URL(`http://${host}`).port;
  return `http://127.0.0.1${port === "" ? "" : `:${port}`}`;
};

export const HobGitHubAppHandlers = HttpApiBuilder.group(HobbotsApi, "hobGitHubApp", (handlers) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(HobGitHubAppService);
    const gate = yield* DeviceGate;
    if (Option.isNone(found)) {
      const absent = new HobGitHubAppRefused({ reason: "no-keychain", message: "This hub does not connect GitHub." });
      return handlers.handleAll({
        status: () => Effect.succeed(NONE),
        start: () => Effect.fail(absent),
        installations: () => Effect.succeed({ installations: [] }),
        disconnect: () => Effect.succeed({ deleteUrl: null, problem: null }),
      });
    }
    const service = found.value;
    return handlers.handleAll({
      status: ({ params }) =>
        service.status(params.agentId).pipe(Effect.mapError(() => new AgentNotFound({ agentId: params.agentId }))),
      start: ({ params }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const place = yield* gate.placeOf(request);
          const hubUrl = hubUrlOf(request);
          // GitHub's redirect reaches only the hub's loopback address (ADR 022).
          if (!Option.exists(place, (where) => where._tag === "Local") || hubUrl === null) {
            return yield* notLocal;
          }
          // The device the middleware admitted, which the state is bound to.
          const device = yield* gate.admit(request);
          return yield* service.start(params.agentId, device.id, hubUrl).pipe(Effect.mapError(refusal(params.agentId)));
        }),
      installations: ({ params }) =>
        service.installations(params.agentId).pipe(
          Effect.map((installations) => ({ installations })),
          Effect.mapError((error) =>
            error._tag === "HobAppRefused"
              ? new AgentNotFound({ agentId: params.agentId })
              : new GitHubUnreachable({ message: error.message }),
          ),
        ),
      disconnect: ({ params }) =>
        service.disconnect(params.agentId).pipe(Effect.mapError(() => new AgentNotFound({ agentId: params.agentId }))),
    });
  }),
);

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

// The manifest page submits its form as soon as it loads; the button is there if scripts are off.
const SUBMIT = `document.getElementById("manifest").submit();`;
const SUBMIT_HASH = `sha256-${createHash("sha256").update(SUBMIT).digest("base64")}`;

/**
 * A bare page: these two are seen for a moment on the way to and from GitHub. They load nothing,
 * send no referrer, are never cached, and post only where `formAction` allows.
 */
const page = (title: string, body: string, options: { readonly formAction?: string; readonly status?: number } = {}) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`,
    {
      status: options.status ?? 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": [
          "default-src 'none'",
          `script-src '${SUBMIT_HASH}'`,
          `form-action ${options.formAction ?? "'none'"}`,
          "base-uri 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      },
    },
  );

const notFound = HttpServerResponse.text("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

/** Runs `answer` only for a local request; any other gets `404`, like an unknown state. */
const localOnly = <E, R>(
  answer: (params: URLSearchParams) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const place = yield* (yield* DeviceGate).placeOf(request);
    if (!Option.exists(place, (where) => where._tag === "Local")) return notFound;
    const url = new URL(request.url, "http://127.0.0.1");
    return yield* answer(url.searchParams);
  });

/** The page that posts the hob's manifest to GitHub, for a live, unused state. */
const ManifestPage = HttpRouter.add(
  "GET",
  HOB_APP_NEW_PATH,
  localOnly((params) =>
    Effect.gen(function* () {
      const service = yield* Effect.serviceOption(HobGitHubAppService);
      if (Option.isNone(service)) return notFound;
      const form = yield* service.value.form(params.get("state") ?? "");
      if (Option.isNone(form)) return notFound;
      const { hobName, action, manifest } = form.value;
      return page(
        `Give ${hobName} its own GitHub app`,
        `<p>GitHub shows the app's name and permissions. You can change the name there, then click Create GitHub App.</p><form id="manifest" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button type="submit">Continue to GitHub</button></form><script>${SUBMIT}</script>`,
        { formAction: new URL(action).origin },
      );
    }),
  ),
);

/** GitHub's redirect back with the code: the hub exchanges it once, then links to installing the app. */
const CallbackPage = HttpRouter.add(
  "GET",
  HOB_APP_CALLBACK_PATH,
  localOnly((params) =>
    Effect.gen(function* () {
      const service = yield* Effect.serviceOption(HobGitHubAppService);
      if (Option.isNone(service)) return notFound;
      return yield* service.value.complete(params.get("state") ?? "", params.get("code") ?? "").pipe(
        Effect.map((made) =>
          page(
            `${made.hobName} has its own GitHub app`,
            `<p>${escapeHtml(made.hobName)} acts on GitHub as ${escapeHtml(`${made.app.slug}[bot]`)}. Choose the repositories it may use: <a href="${escapeHtml(made.installUrl)}">install the app on GitHub</a>. Then you can close this page.</p>`,
          ),
        ),
        Effect.catch((failed) =>
          failed.reason === "unknown"
            ? Effect.succeed(notFound)
            : Effect.succeed(
                page(
                  "The hob's GitHub app was not kept",
                  `<p>${escapeHtml(failed.message)}</p>${failed.deleteUrl === null ? "" : `<p><a href="${escapeHtml(failed.deleteUrl)}">Delete the app on GitHub</a>.</p>`}`,
                  { status: 409 },
                ),
              ),
        ),
      );
    }),
  ),
);

/** The two pages a browser on the hub opens without a device. */
export const HobGitHubAppPages = Layer.mergeAll(ManifestPage, CallbackPage);

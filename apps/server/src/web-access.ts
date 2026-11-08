import { makeWebTools, type WebFetcher, WebTools } from "@hobbots/agents";
import { decideHubCall, PolicyEngine } from "@hobbots/permissions";
import { WebAccessLive } from "@hobbots/web-access";
import { Effect, Layer } from "effect";

/**
 * `web_fetch` (ADR 036) over the fetcher it is given, served on the hub beside the memory, skill and
 * directory tools on every runtime that serves hub tools. Each call is decided as Use the web for
 * the page's host with the hob's live grants, as every hub tool's call is, and the hub's tailnet
 * addresses are refused like loopback.
 */
export const WebToolsWith = <E, R>(fetcher: Layer.Layer<WebFetcher, E, R>) =>
  Layer.effect(
    WebTools,
    Effect.gen(function* () {
      const engine = yield* PolicyEngine;
      return yield* makeWebTools((approvals, base, request) => decideHubCall(engine, approvals, base, request));
    }),
  ).pipe(Layer.provide(Layer.mergeAll(PolicyEngine.node, fetcher)));

/** `web_fetch` reading pages through `@hobbots/web-access`, from the hub's own network. */
export const WebToolsLive = (version: string) => WebToolsWith(WebAccessLive({ version }));

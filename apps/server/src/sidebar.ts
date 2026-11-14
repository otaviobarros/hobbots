import { BlockedWork, SidebarList, sessionActor, unlistedUser } from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Sidebar } from "@hobbots/domain";
import { Backpack } from "@hobbots/inbox";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The sidebar (ADR 039, The sidebar; #1469), for user sessions only (PE-006): the route exposes
// `SidebarList`, which reads and sorts it in `packages/agents`. A hub built without it, as in some
// tests, lists nothing for anyone.

/** The blocked work the sidebar marks Needs you: the Backpack's, across the workspace. */
export const BlockedWorkLive = Layer.effect(
  BlockedWork,
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    return BlockedWork.of({ list: backpack.listBlocked({ _tag: "Workspace" }) });
  }),
);

export const SidebarHandlers = HttpApiBuilder.group(HobbotsApi, "sidebar", (handlers) =>
  Effect.gen(function* () {
    const list = Option.getOrElse(yield* Effect.serviceOption(SidebarList), () =>
      SidebarList.of({
        current: Effect.map(sessionActor, (you) => ({
          you: unlistedUser(you),
          people: [],
          sidebar: new Sidebar({ camps: [], directMessages: [] }),
        })),
      }),
    );
    return handlers.handleAll({ current: () => list.current });
  }),
);

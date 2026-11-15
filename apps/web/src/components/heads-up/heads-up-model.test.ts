import {
  AgentId,
  Claim,
  ClaimClash,
  ClaimId,
  ClashSide,
  Message,
  MessageId,
  type TaskId,
  ChannelId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { BEFORE_FIRST, headsUpOf, placeHeadsUps } from "./heads-up-model.ts";

// #1390: the Heads-up a camp shows for a clash between two quests' claims.

const CAMP = ChannelId.make("camp");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");
const at = (second: number) => `2026-11-12T10:00:${String(second).padStart(2, "0")}.000Z`;

const side = (
  id: string,
  owner: AgentId,
  key: string,
  second: number,
  channelId: ChannelId,
  scope: Claim["scope"] = "path",
) =>
  new ClashSide({
    claim: new Claim({
      id: ClaimId.make(id),
      scope,
      repository: "github.com/me/shop",
      directory: null,
      key,
      taskId: `task-${id}` as TaskId,
      actor: { kind: "hob", id: owner },
      state: "contested",
      createdAt: at(second),
      updatedAt: at(second),
      releasedAt: null,
      revision: 1 as Claim["revision"],
    }),
    ownerId: owner,
    brief: `Task ${id}\nWith a longer brief`,
    channelId,
  });

const message = (id: string, second: number) =>
  new Message({
    id: MessageId.make(id),
    channelId: CAMP,
    role: "user",
    content: id,
    status: "complete",
    error: null,
    configVersion: null,
    createdAt: at(second),
  });

describe("a Heads-up for a clash", () => {
  it("names each side by its hob, task and claim, says which is elsewhere and who claimed last (#1390)", () => {
    const clash = new ClaimClash({
      sides: [side("badge", QUILL, "web/badge.png", 5, CAMP), side("review", ADA, "web", 9, ChannelId.make("other"))],
      since: at(9),
    });
    const headsUp = headsUpOf(clash, CAMP);
    expect(headsUp?.scope).toBe("path");
    expect(headsUp?.sides.map((each) => [each.ownerId, each.on, each.elsewhere])).toEqual([
      [QUILL, "web/badge.png", false],
      [ADA, "web", true],
    ]);
    expect(headsUp?.spotted.ownerId).toBe(ADA);
    expect(
      headsUpOf(new ClaimClash({ sides: [side("alone", QUILL, "main", 1, CAMP, "branch")], since: at(1) }), CAMP),
    ).toBeNull();
  });

  it("sits under the last message written before the clash began (#1390)", () => {
    const clash = (second: number) =>
      headsUpOf(
        new ClaimClash({
          sides: [side(`a${second}`, QUILL, "x", second, CAMP), side(`b${second}`, ADA, "x", second, CAMP)],
          since: at(second),
        }),
        CAMP,
      );
    const early = clash(1);
    const late = clash(30);
    if (early === null || late === null) throw new Error("no Heads-up");
    const placed = placeHeadsUps([message("ask", 2), message("steer", 20)], [early, late]);
    expect(placed.get(BEFORE_FIRST)).toEqual([early]);
    expect(placed.get(MessageId.make("steer"))).toEqual([late]);
  });
});

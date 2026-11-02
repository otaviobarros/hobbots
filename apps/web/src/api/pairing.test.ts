import type { WaitingDevice } from "@hobbots/api";
import { PairingRequest } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { askedFrom, groupedCode, usingText } from "../components/pairing/device-request-model.ts";
import { messages } from "../components/pairing/messages.ts";
import { ApiError } from "./client.ts";
import { describeBrowser, promptedDevices, refusedState, waitingState } from "./pairing.ts";

const asking = (overrides: Partial<PairingRequest> = {}): PairingRequest =>
  new PairingRequest({
    id: "p1",
    code: "482913",
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iPhone",
    tailscale: {
      nodeId: "nPHONE",
      nodeName: "phone.example.ts.net",
      owner: { _tag: "User", login: "you@example.com" },
    },
    state: "pending",
    createdAt: "2026-11-02T10:00:00.000Z",
    expiresAt: "2026-11-02T10:10:00.000Z",
    decidedAt: null,
    deviceId: null,
    ...overrides,
  });

const waiting = (request: PairingRequest, fromHub = false): WaitingDevice => ({ request, fromHub });

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("pairing in the web client", () => {
  // covers DP-004
  it("[TC-DP-097] suggests a name from the browser, and shows the code in two groups of three", () => {
    expect(messages.suggestedName(describeBrowser(IPHONE))).toBe("Safari on iPhone");
    expect(messages.suggestedName(describeBrowser(CHROME_MAC))).toBe("Chrome on Mac");
    expect(messages.suggestedName(describeBrowser(""))).toBe("Browser");
    expect(groupedCode("482913")).toBe("482 913");
  });

  // covers DP-004
  it("[TC-DP-098] the waiting screen follows the request, and explains a refusal over a limit or from another account", () => {
    const status = { id: "p1", code: "482913", expiresAt: "2026-11-02T10:10:00.000Z" };
    expect(waitingState({ ...status, state: "pending" })).toMatchObject({ _tag: "Waiting" });
    expect(waitingState({ ...status, state: "claimed" })).toEqual({ _tag: "Allowed" });
    expect(waitingState({ ...status, state: "denied" })).toEqual({ _tag: "Denied" });
    expect(waitingState({ ...status, state: "expired" })).toEqual({ _tag: "Expired" });
    expect(refusedState(new ApiError("", "PairingThrottled", { retryAfterSeconds: 42 }))).toEqual({
      _tag: "Throttled",
      seconds: 42,
    });
    expect(refusedState(new ApiError("", "PairingRefused", { reason: "notYours" }))).toEqual({ _tag: "NotYours" });
    expect(refusedState(new Error("offline"))).toBeUndefined();
  });

  // covers DP-004
  it("[TC-DP-099] prompts only for devices not put off, and says where each asked from", () => {
    const deferred = asking({ id: "p2", expiresAt: "2026-11-03T10:00:00.000Z" });
    expect(promptedDevices([waiting(asking()), waiting(deferred)]).map((device) => device.request.id)).toEqual(["p1"]);
    expect(askedFrom(waiting(asking()))).toBe("phone · you@example.com");
    expect(askedFrom(waiting(asking({ tailscale: null }), true))).toBe("From this computer");
    expect(
      askedFrom(
        waiting(asking({ tailscale: { nodeId: "nCI", nodeName: "ci", owner: { _tag: "Tagged", tags: ["tag:ci"] } } })),
      ),
    ).toBe("ci · tagged tag:ci");
    expect(usingText(waiting(asking()))).toBe("A browser · iPhone");
  });
});

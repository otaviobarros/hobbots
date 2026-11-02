import { describe, expect, it } from "vitest";
import { PairingRequest, type PairingState, pairingExpired } from "../src/index.ts";

const EXPIRES = "2026-11-02T10:10:00.000Z";

const inState = (state: PairingState) =>
  new PairingRequest({
    id: "p1",
    code: "482913",
    name: "Safari on iPhone",
    kind: "browser",
    platform: "iOS",
    tailscale: null,
    state,
    createdAt: "2026-11-02T10:00:00.000Z",
    expiresAt: EXPIRES,
    decidedAt: state === "pending" ? null : "2026-11-02T10:05:00.000Z",
    deviceId: null,
  });

describe("pairing requests", () => {
  // covers DP-004
  it("[TC-DP-087] a pending or allowed request expires at its deadline, and a decided one keeps its state", () => {
    const before = "2026-11-02T10:09:59.999Z";
    expect(pairingExpired(inState("pending"), before)).toBe(false);
    expect(pairingExpired(inState("allowed"), before)).toBe(false);
    // Allowed in time but not yet claimed: once the deadline passes it can no longer give a token.
    expect(pairingExpired(inState("pending"), EXPIRES)).toBe(true);
    expect(pairingExpired(inState("allowed"), EXPIRES)).toBe(true);
    expect(pairingExpired(inState("denied"), EXPIRES)).toBe(false);
    expect(pairingExpired(inState("claimed"), EXPIRES)).toBe(false);
  });
});

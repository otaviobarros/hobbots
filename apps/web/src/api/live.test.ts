import { describe, expect, it } from "vitest";
import { ApiError } from "./client.ts";
import { accessAfter } from "./live.ts";

describe("accessAfter", () => {
  it("reads a revoked device and a hub out of reach from a failed call, and nothing else", () => {
    expect(accessAfter(new ApiError("DeviceRevoked", "DeviceRevoked"))).toBe("removed");
    expect(
      accessAfter(new ApiError("Transport error", "HttpClientError", { reason: { _tag: "TransportError" } })),
    ).toBe("unreachable");
    // An answer from the hub, even a refusal, shows it is reachable and says nothing about removal.
    expect(accessAfter(new ApiError("DeviceRequired", "DeviceRequired"))).toBeNull();
    expect(accessAfter(new ApiError("Bad", "HttpClientError", { reason: { _tag: "StatusCodeError" } }))).toBeNull();
    expect(accessAfter(new Error("other"))).toBeNull();
  });
});

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "./client.ts";
import { accessAfter, type DeviceAccess, probeAccess, retryUnlessRefused, setDeviceAccess } from "./live.ts";

const access = (queryClient: QueryClient) => queryClient.getQueryData<DeviceAccess>(["device-access"]);
const revoked = new ApiError("DeviceRevoked", "DeviceRevoked");
const unreachable = new ApiError("Transport error", "HttpClientError", { reason: { _tag: "TransportError" } });

/** A call that settles only when the test says so, to finish probes out of order. */
const pending = () => {
  let settle: (outcome: { readonly error?: unknown }) => void = () => {};
  const promise = new Promise<unknown>((resolve, reject) => {
    settle = ({ error }) => (error === undefined ? resolve([]) : reject(error));
  });
  return { call: () => promise, settle };
};

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

describe("device access", () => {
  // covers DP-004
  it("[TC-DP-102] notes a revocation on a read's first failure and never retries a refusal", () => {
    const queryClient = new QueryClient();
    expect(retryUnlessRefused(queryClient, 0, unreachable)).toBe(true);
    expect(retryUnlessRefused(queryClient, 3, unreachable)).toBe(false);
    expect(access(queryClient)).toBeUndefined();
    expect(retryUnlessRefused(queryClient, 0, new ApiError("DeviceRequired", "DeviceRequired"))).toBe(false);
    expect(retryUnlessRefused(queryClient, 0, revoked)).toBe(false);
    expect(access(queryClient)).toBe("removed");
  });

  // covers DP-004
  it("[TC-DP-103] keeps a removal whatever later answer arrives, and only the latest probe's other answers", async () => {
    const queryClient = new QueryClient();
    const first = pending();
    const second = pending();
    const older = probeAccess(queryClient, first.call);
    const newer = probeAccess(queryClient, second.call);
    // The newer probe answers first; the older one's late answer is ignored.
    second.settle({ error: unreachable });
    await newer;
    first.settle({});
    await older;
    expect(access(queryClient)).toBe("unreachable");

    // A revocation counts even from an older probe, and nothing afterwards undoes it.
    const third = pending();
    const fourth = pending();
    const revoking = probeAccess(queryClient, third.call);
    const approving = probeAccess(queryClient, fourth.call);
    third.settle({ error: revoked });
    await revoking;
    fourth.settle({});
    await approving;
    expect(access(queryClient)).toBe("removed");
    setDeviceAccess(queryClient, "approved");
    expect(access(queryClient)).toBe("removed");
  });
});

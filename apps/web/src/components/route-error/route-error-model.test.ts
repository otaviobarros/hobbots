import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client.ts";
import { failureOf } from "./route-error-model.ts";

describe("failureOf", () => {
  it("reads a request the hub never answered as unreachable", () => {
    const error = new ApiError("Transport error", "HttpClientError", { reason: { _tag: "TransportError" } });
    expect(failureOf(error)).toBe("unreachable");
  });

  it("reads a thing the hub no longer has as missing", () => {
    expect(failureOf(new ApiError("ThreadNotFound", "ThreadNotFound"))).toBe("missing");
    expect(failureOf(new ApiError("AgentNotFound", "AgentNotFound"))).toBe("missing");
  });

  it("reads anything else as unknown", () => {
    expect(failureOf(new TypeError("x is undefined"))).toBe("unknown");
    expect(failureOf(new ApiError("Internal", "InternalError"))).toBe("unknown");
    expect(failureOf("thrown text")).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { hubNameOf, isLoopbackHost } from "./hub-name.ts";

describe("hubNameOf", () => {
  it("takes the first label of the hub's MagicDNS name", () => {
    expect(hubNameOf("hub.example.ts.net")).toBe("hub");
    expect(hubNameOf("Studio-Mac.tail1234.ts.net")).toBe("studio-mac");
  });

  it("has no name on loopback or a bare address", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "100.101.102.103", "[fd7a:115c:a1e0::1]", ""]) {
      expect(hubNameOf(host)).toBeNull();
    }
  });
});

describe("isLoopbackHost", () => {
  it("knows the hub's own computer from a tailnet address", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("hub.example.ts.net")).toBe(false);
    expect(isLoopbackHost("100.101.102.103")).toBe(false);
  });
});

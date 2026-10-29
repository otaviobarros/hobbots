import { describe, expect, it } from "vitest";
import { loginItemNotice } from "./login-item.ts";

describe("the login item notice", () => {
  it("says nothing when macOS registered it, or when it is off", () => {
    expect(loginItemNotice({ openAtLogin: true, status: "enabled" })).toBeUndefined();
    expect(loginItemNotice({ openAtLogin: false, status: "not-registered" })).toBeUndefined();
  });

  it("points to System Settings while macOS waits for approval", () => {
    expect(loginItemNotice({ openAtLogin: true, status: "requires-approval" })?.tone).toBe("wait");
  });

  it("calls a refused registration a problem", () => {
    expect(loginItemNotice({ openAtLogin: true, status: "not-registered" })?.tone).toBe("problem");
    expect(loginItemNotice({ openAtLogin: true, status: "not-found" })?.tone).toBe("problem");
  });

  it("explains that a development build cannot open at login", () => {
    expect(loginItemNotice({ openAtLogin: true, status: "unavailable" })?.text).toMatch(/installed/);
  });
});

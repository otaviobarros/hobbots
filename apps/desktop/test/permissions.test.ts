import { describe, expect, it } from "vitest";
import { allowsPermission, limitPermissions, type PermissionSession } from "../src/main/permissions.ts";

describe("web permissions", () => {
  it("are refused, except writing to the clipboard from the window's own page", () => {
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "openExternal", "unknown"]) {
      expect(allowsPermission(permission, true)).toBe(false);
    }
    expect(allowsPermission("clipboard-sanitized-write", true)).toBe(true);
    // A frame inside the page gets nothing.
    expect(allowsPermission("clipboard-sanitized-write", false)).toBe(false);
  });

  it("are answered by both the request and the check handler of a session", () => {
    let request: Parameters<PermissionSession["setPermissionRequestHandler"]>[0] | undefined;
    let check: Parameters<PermissionSession["setPermissionCheckHandler"]>[0] | undefined;
    limitPermissions({
      setPermissionRequestHandler: (handler) => {
        request = handler;
      },
      setPermissionCheckHandler: (handler) => {
        check = handler;
      },
    });
    const granted: boolean[] = [];
    request?.(null, "media", (answer) => granted.push(answer), { isMainFrame: true });
    request?.(null, "clipboard-sanitized-write", (answer) => granted.push(answer), { isMainFrame: true });
    expect(granted).toEqual([false, true]);
    expect(check?.(null, "geolocation", "http://127.0.0.1:4317", { isMainFrame: true })).toBe(false);
    expect(check?.(null, "clipboard-sanitized-write", "http://127.0.0.1:4317", { isMainFrame: true })).toBe(true);
  });
});

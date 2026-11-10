import { Redacted } from "effect";
import { describe, expect, it } from "vitest";
import { messages } from "../messages.ts";
import {
  EMPTY_LINK,
  KEY_FILE_MAX,
  linkErrors,
  linkOf,
  missingAcross,
  missingText,
  refusalField,
} from "./hob-github-app-link-model.ts";

const copy = messages.charms.github.app;
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";

describe("the link form's rules", () => {
  it("asks for an App ID or Client ID and a whole private key", () => {
    expect(linkErrors(EMPTY_LINK)).toEqual({ appId: copy.appIdMissing, privateKey: copy.keyMissing });
    expect(linkErrors({ appId: " 123456 ", privateKey: `\n${KEY}\n` })).toEqual({});
    expect(linkErrors({ appId: "Iv23liAbCd.01", privateKey: KEY.replace("RSA ", "").replace("RSA ", "") })).toEqual({});
    expect(linkErrors({ appId: "my app", privateKey: KEY })).toEqual({ appId: copy.appIdMissing });
    // Half a key, as a copy that stopped short gives.
    expect(linkErrors({ appId: "1", privateKey: KEY.slice(0, 40) })).toEqual({ privateKey: copy.keyMissing });
    expect(linkErrors({ appId: "1", privateKey: "x".repeat(KEY_FILE_MAX + 1) })).toEqual({
      privateKey: copy.keyTooLarge,
    });
  });

  it("sends the trimmed ID and the key redacted", () => {
    const sent = linkOf({ appId: " 42 ", privateKey: `${KEY}\n` });
    expect(sent.appId).toBe("42");
    expect(Redacted.value(sent.privateKey)).toBe(KEY);
    expect(String(sent.privateKey)).not.toContain("PRIVATE KEY");
  });

  it("shows a refusal by the field it is about", () => {
    expect(refusalField("bad-id")).toBe("appId");
    expect(refusalField("key-refused")).toBe("privateKey");
    expect(refusalField("not-a-key")).toBe("privateKey");
    expect(refusalField("taken")).toBeNull();
  });

  it("names the permissions a linked app lacks in one sentence", () => {
    expect(
      missingText("Rosie", [
        { name: "contents", access: "write" },
        { name: "statuses", access: "read" },
      ]),
    ).toContain("Contents (read and write) and Commit statuses (read)");
  });
});

describe("what the app's installations lack", () => {
  it("names each missing permission once, with write where any installation lacks write", () => {
    expect(missingAcross([])).toEqual([]);
    expect(
      missingAcross([
        { missingPermissions: [{ name: "issues", access: "read" }] },
        {
          missingPermissions: [
            { name: "issues", access: "write" },
            { name: "checks", access: "read" },
          ],
        },
        { missingPermissions: [{ name: "issues", access: "read" }] },
      ]),
    ).toEqual([
      { name: "issues", access: "write" },
      { name: "checks", access: "read" },
    ]);
  });
});

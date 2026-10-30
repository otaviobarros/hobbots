import { describe, expect, it } from "vitest";
import { sendErrorText } from "./send-error.ts";

describe("sendErrorText", () => {
  const active = { name: "Moss", status: "active" };
  const paused = { name: "Moss", status: "paused" };

  it("tells the user to wake a paused hob", () =>
    expect(sendErrorText({ message: "HobUnavailable", tag: "HobUnavailable" }, paused)).toBe(
      "Moss is paused, so this message was not sent. Wake Moss, then send it again.",
    ));
  it("says a hob that is not paused cannot take work", () =>
    expect(sendErrorText({ message: "HobUnavailable", tag: "HobUnavailable" }, active)).toBe(
      "Moss cannot take new work right now, so this message was not sent.",
    ));
  it("keeps other errors' words", () =>
    expect(sendErrorText({ message: "Failed to fetch" }, active)).toBe("Could not send: Failed to fetch"));
  it("never shows an empty error", () =>
    expect(sendErrorText({ message: " " }, active)).toBe(
      "Could not send. Check that Hobbots is running, then try again.",
    ));
});

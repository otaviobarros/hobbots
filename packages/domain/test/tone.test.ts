import { describe, expect, it } from "vitest";
import {
  REPLY_LENGTHS,
  ReplyLength,
  systemInstructions,
  THEMED_VOICE_GUARD,
  toneLines,
  VOICE_GROUPS,
  VOICES,
  Voice,
} from "../src/index.ts";

const line = (id: Voice) => VOICES.find((v) => v.id === id)?.line;
const lengthLine = (id: ReplyLength) => REPLY_LENGTHS.find((l) => l.id === id)?.line;

describe("tone", () => {
  it("offers every voice and length once, in the picker's groups", () => {
    expect(VOICES.map((v) => v.id)).toEqual(Voice.literals);
    expect(REPLY_LENGTHS.map((l) => l.id)).toEqual(ReplyLength.literals);
    expect(VOICE_GROUPS.map((g) => [g.title, VOICES.filter((v) => v.group === g.id).map((v) => v.title)])).toEqual([
      ["Everyday", ["Default", "Friendly", "Professional", "Candid", "Efficient"]],
      ["Expert", ["Technical", "Professor", "Mentor", "Skeptic"]],
      ["Themed", ["Bard", "Old wizard", "Pirate", "Noir detective", "Shakespearean"]],
    ]);
    for (const choice of [...VOICES, ...REPLY_LENGTHS]) expect(choice.description).not.toBe("");
  });

  it("adds nothing for Default and Balanced", () => {
    expect(toneLines("default", "balanced")).toEqual([]);
  });

  it.each(VOICES.filter((v) => v.group !== "themed" && v.id !== "default"))(
    "tells the runtime the $title voice in one line",
    (voice) => {
      expect(toneLines(voice.id, "balanced")).toEqual([voice.line]);
    },
  );

  it.each(VOICES.filter((v) => v.group === "themed"))("follows the $title voice with the themed guard", (voice) => {
    expect(toneLines(voice.id, "balanced")).toEqual([voice.line, THEMED_VOICE_GUARD]);
  });

  it.each(REPLY_LENGTHS.filter((l) => l.id !== "balanced"))("tells the runtime the $title length", (length) => {
    expect(toneLines("default", length.id)).toEqual([length.line]);
  });

  it("puts the voice, then the length, then the guard", () => {
    expect(toneLines("wizard", "brief")).toEqual([line("wizard"), lengthLine("brief"), THEMED_VOICE_GUARD]);
    expect(toneLines("candid", "detailed")).toEqual([line("candid"), lengthLine("detailed")]);
  });

  it("puts How you talk between About you and the user's instructions", () => {
    expect(
      systemInstructions("Pip", {
        role: "researcher",
        roleTitle: "Researcher",
        voice: "wizard",
        length: "brief",
        instructions: "Cite sources.",
      }),
    ).toBe(
      [
        "## About you",
        "You are Pip, a hob in Hobbots. Your role is Researcher: digs up sources and sums up what it finds.",
        "",
        "## How you talk",
        "Speak as an old hob wizard: grand, a little cryptic and fond of lore, yet always clear in the end.",
        "Keep replies short: a few sentences or a short list, unless the user asks for more.",
        THEMED_VOICE_GUARD,
        "",
        "## Your instructions, from the user",
        "Cite sources.",
      ].join("\n"),
    );
  });

  it("leaves How you talk out when the tone is at its defaults", () => {
    expect(
      systemInstructions("Pip", {
        role: null,
        roleTitle: "Gardener",
        voice: "default",
        length: "balanced",
        instructions: "",
      }),
    ).not.toContain("How you talk");
    expect(
      systemInstructions("Pip", {
        role: null,
        roleTitle: "Gardener",
        voice: "default",
        length: "brief",
        instructions: "",
      }),
    ).toBe(
      `## About you\nYou are Pip, a hob in Hobbots. Your role is Gardener.\n\n## How you talk\n${lengthLine("brief")}`,
    );
  });
});

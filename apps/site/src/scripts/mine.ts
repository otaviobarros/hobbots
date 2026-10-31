import type { HobColor } from "@hobbots/art/look";
import { hobLook } from "@hobbots/art/look";
import { redraw } from "./pixels.ts";

/** The visitor's own hob: rolled on the page, it keeps their spot and follows them down the page. */

export interface Mine {
  readonly seed: number;
  readonly color: HobColor;
  readonly name: string;
}

export const NAMES = [
  "Pip",
  "Bramble",
  "Tinker",
  "Quill",
  "Moss",
  "Fennel",
  "Wick",
  "Thistle",
  "Juniper",
  "Pebble",
  "Nettle",
  "Clover",
  "Rook",
  "Sage",
  "Sorrel",
  "Bracken",
];

export const MINE_CHIRP = [698, 880, 784];

let mine: Mine = { seed: 11, color: "violet", name: "Pip" };

export const getMine = () => mine;

const setText = (selector: string, text: string) => {
  for (const element of document.querySelectorAll(selector)) element.textContent = text;
};

const render = () => {
  const look = hobLook(mine.seed, mine.color);
  for (const svg of document.querySelectorAll<SVGSVGElement>("svg[data-mine]")) {
    redraw(svg, look.rows, look.palette);
    if (svg.hasAttribute("aria-label")) svg.setAttribute("aria-label", `${mine.name}, with ${look.recipe}`);
  }
  setText("[data-mine-name]", mine.name);
  setText("[data-mine-look]", look.recipe);
  setText("[data-save-label]", `Save ${mine.name}’s spot`);
  for (const button of document.querySelectorAll("[data-mine-label]"))
    button.setAttribute("aria-label", `Say hi to ${mine.name}`);
};

export const setMine = (next: Partial<Mine>) => {
  mine = { ...mine, ...next };
  render();
};

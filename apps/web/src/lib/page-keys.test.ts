import { describe, expect, it } from "vitest";
import { isPageKey, isTextField, type KeyPress } from "./page-keys.ts";

const element = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as Element;

/** An element whose nearest match for `closest` is `inside`, or none. */
const placed = (tagName: string, inside: boolean, extra: Record<string, unknown> = {}) =>
  element(tagName, { closest: () => (inside ? element("DIV") : null), ...extra });

const press = (key: string, fields: Partial<KeyPress> = {}): KeyPress => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: placed("BUTTON", false),
  ...fields,
});

describe("isTextField", () => {
  it("knows text inputs, text areas and editable content from buttons and links", () => {
    expect(isTextField(element("TEXTAREA"))).toBe(true);
    expect(isTextField(element("INPUT", { type: "search" }))).toBe(true);
    expect(isTextField(element("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextField(element("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextField(element("BUTTON"))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe("isPageKey", () => {
  it("takes a plain key pressed on the page, a button or a check box", () => {
    expect(isPageKey(press("j"))).toBe(true);
    expect(isPageKey(press("a", { target: placed("INPUT", false, { type: "checkbox" }) }))).toBe(true);
    expect(isPageKey(press("ArrowDown", { target: null }))).toBe(true);
  });

  it("leaves a key with a modifier, or one already handled, to whoever wants it", () => {
    expect(isPageKey(press("ArrowDown", { altKey: true }))).toBe(false);
    expect(isPageKey(press("a", { metaKey: true }))).toBe(false);
    expect(isPageKey(press("a", { ctrlKey: true }))).toBe(false);
    expect(isPageKey(press("j", { defaultPrevented: true }))).toBe(false);
  });

  it("never acts while typing, or inside a widget, dialog or menu that handles keys itself", () => {
    expect(isPageKey(press("a", { target: placed("TEXTAREA", false) }))).toBe(false);
    expect(isPageKey(press("d", { target: placed("INPUT", false, { type: "text" }) }))).toBe(false);
    expect(isPageKey(press("ArrowDown", { target: placed("BUTTON", true) }))).toBe(false);
  });
});

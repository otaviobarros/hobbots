import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { followWindowFocus } from "./window-focus.ts";

describe("followWindowFocus", () => {
  afterEach(() => focusManager.setFocused(undefined));

  it("[TC-GEN-038] counts the window coming back into focus, not only becoming visible", () => {
    const window = new EventTarget();
    let visible = true;
    followWindowFocus(window, () => visible);
    const comebacks: Array<boolean> = [];
    const unsubscribe = focusManager.subscribe((focused) => comebacks.push(focused));

    // The desktop app stays visible while the person works in the browser.
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    // A browser tab is hidden, then shown.
    visible = false;
    window.dispatchEvent(new Event("visibilitychange"));
    visible = true;
    window.dispatchEvent(new Event("visibilitychange"));

    expect(comebacks).toEqual([false, true, false, true]);
    unsubscribe();
  });
});

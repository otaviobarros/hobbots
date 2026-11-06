import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Violations at these impacts fail a scan (STD-TEST-007); minor and moderate ones are reported, not failed. */
const FAILING = new Set(["serious", "critical"]);

/**
 * Waits until no animation or transition that can change how text reads is still playing on what
 * a scan checks: the element marked `scanId`, or the whole page, together with its ancestors.
 *
 * Text that is fading in reads as low contrast to axe, so a scan that lands inside a fade reports
 * whichever nodes the fade had not lifted yet (#1000). Only finite animations of the properties
 * that axe's contrast check reads, on elements that hold text, are waited for: a spinner that
 * turns until its reply arrives never ends, and the scene's twinkling stars hold no text.
 */
const untilSettled = (page: Page, scanId: string | undefined) =>
  page.waitForFunction((id) => {
    const root = id === undefined ? document.documentElement : document.querySelector(`[data-axe-scan="${id}"]`);
    if (root === null) return true;
    const reads = new Set(["opacity", "color", "backgroundColor", "background", "filter"]);
    return document.getAnimations().every((animation) => {
      if (animation.playState !== "running" && !animation.pending) return true;
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) return true;
      const target = effect.target;
      if (target === null || !(root.contains(target) || target.contains(root))) return true;
      if ((target.textContent ?? "").trim() === "") return true;
      if (!Number.isFinite(effect.getComputedTiming().endTime)) return true;
      return !effect.getKeyframes().some((frame) => Object.keys(frame).some((property) => reads.has(property)));
    });
  }, scanId);

/**
 * Scans what the page shows once it has settled with axe, or only `within` when given, and fails
 * on any serious or critical violation, naming each rule and the elements that break it.
 */
export const expectAccessible = async (page: Page, within?: Locator) => {
  let builder = new AxeBuilder({ page });
  let scanId: string | undefined;
  if (within !== undefined) {
    scanId = await within.evaluate((element) => {
      element.dataset.axeScan ??= crypto.randomUUID();
      return element.dataset.axeScan;
    });
    builder = builder.include(`[data-axe-scan="${scanId}"]`);
  }
  await untilSettled(page, scanId);
  const { violations } = await builder.analyze();
  const failing = violations
    .filter((violation) => FAILING.has(violation.impact ?? ""))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  expect(failing).toEqual([]);
};

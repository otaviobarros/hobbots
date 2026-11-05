import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

/** Violations at these impacts fail a scan (STD-TEST-007); minor and moderate ones are reported, not failed. */
const FAILING = new Set(["serious", "critical"]);

/**
 * Scans what the page shows now with axe, or only `within` when given, and fails on any serious or
 * critical violation, naming each rule and the elements that break it.
 */
export const expectAccessible = async (page: Page, within?: Locator) => {
  let builder = new AxeBuilder({ page });
  if (within !== undefined) {
    const id = await within.evaluate((element) => {
      element.dataset.axeScan ??= crypto.randomUUID();
      return element.dataset.axeScan;
    });
    builder = builder.include(`[data-axe-scan="${id}"]`);
  }
  const { violations } = await builder.analyze();
  const failing = violations
    .filter((violation) => FAILING.has(violation.impact ?? ""))
    .map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
  expect(failing).toEqual([]);
};

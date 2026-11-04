/**
 * The few page calls following the theme needs. The desktop app builds without the DOM's types,
 * so they are named here.
 */
export interface ThemedPage {
  readonly document: { readonly documentElement: object };
  readonly getComputedStyle: (element: object) => { readonly getPropertyValue: (name: string) => string };
  readonly MutationObserver: new (
    callback: () => void,
  ) => {
    readonly observe: (target: object, options: { attributes: true; attributeFilter: string[] }) => void;
  };
  readonly addEventListener: (type: "DOMContentLoaded", listener: () => void) => void;
}

/**
 * Reports the theme's `ground` once the page has loaded and again each time `data-theme` changes it,
 * so the window behind the page can match. A ground that did not change is not reported again.
 */
export const followTheme = (page: ThemedPage, report: (ground: string) => void) => {
  let reported = "";
  const check = () => {
    const root = page.document.documentElement;
    const ground = page.getComputedStyle(root).getPropertyValue("--color-ground").trim();
    if (ground === "" || ground === reported) return;
    reported = ground;
    report(ground);
  };
  page.addEventListener("DOMContentLoaded", () => {
    check();
    new page.MutationObserver(check).observe(page.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  });
};

import { createCn } from "cn/config";

/**
 * The app's type styles and skin corners (`apps/web/src/styles.css`), so merging classes knows that
 * `text-body` sets a size, not a color, and that `rounded-control` is a corner. Without them a later
 * `text-text` drops `text-body`, and `rounded-none` cannot replace `rounded-control`.
 */
export const THEME_TEXT_STYLES = ["display", "heading", "title", "reading", "body", "ui", "detail", "meta", "code"];
export const THEME_CORNERS = ["control", "card", "tag", "dot", "tile"];

/** Joins class names and drops the ones a later class overrides, as tailwind-merge does. */
export const cn = createCn({ extend: { theme: { text: THEME_TEXT_STYLES, radius: THEME_CORNERS } } });

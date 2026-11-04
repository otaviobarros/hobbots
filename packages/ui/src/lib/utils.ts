import { createCn } from "cn/config";

/**
 * The type scale's text sizes (`type` in docs/design/themes.json). Without them, `cn` would read
 * `text-ui` as a text color and drop it beside `text-text-strong`.
 */
export const TEXT_STYLES = ["display", "heading", "title", "reading", "body", "ui", "detail", "meta", "code"] as const;

export const cn = createCn({ extend: { classGroups: { "font-size": [{ text: [...TEXT_STYLES] }] } } });

/** The parts of an HTML syntax tree (hast) node needed to read its text. */
export interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly tagName?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<HastNode>;
}

/** The text in a node, without the highlighting spans around it. */
export const hastText = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");

/** The language a fenced code block names, such as `ts` from ```` ```ts ````. */
export const codeLanguage = (pre: HastNode): string | null => {
  const code = pre.children?.find((child) => child.tagName === "code");
  const classes = code?.properties?.["className"];
  if (!Array.isArray(classes)) return null;
  const language = classes.find((name): name is string => typeof name === "string" && name.startsWith("language-"));
  return language ? language.slice("language-".length) : null;
};

/** Whether a node holds an image, as a badge inside a link does. */
export const hasImage = (node: HastNode): boolean => node.tagName === "img" || (node.children ?? []).some(hasImage);

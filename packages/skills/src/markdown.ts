import { parse, postprocess, preprocess } from "micromark";
import { frontmatter } from "micromark-extension-frontmatter";

// A skill's files are read as Markdown by a CommonMark parser, never by hand (STD-DUP-008): its
// YAML front matter, its links and its reference definitions, with code blocks and code spans left
// as code, exactly as the spec defines them. One pass over a file reads all of them.

/** Where a link's target is written in a file, by UTF-16 offsets, `from` included and `to` not. */
export interface LinkTarget {
  readonly from: number;
  readonly to: number;
  readonly target: string;
}

/** What a skill's file holds that the import reads. */
export interface SkillMarkdown {
  /** Its YAML front matter and the text after it, or null when it opens with none. */
  readonly frontMatter: { readonly yaml: string; readonly rest: string } | null;
  /** Its link targets, in the order they are written. */
  readonly links: ReadonlyArray<LinkTarget>;
}

/** HTML `src` and `href` attributes, as a skill's raw HTML can link with them. */
const HTML_ATTRIBUTE = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

/** Destinations of links, images and reference definitions, and autolinks. */
const DESTINATIONS: ReadonlySet<string> = new Set([
  "resourceDestinationString",
  "definitionDestinationString",
  "autolinkProtocol",
]);
const HTML: ReadonlySet<string> = new Set(["htmlFlow", "htmlText"]);
const BOM = "\uFEFF";

/**
 * The tokens of micromark, the CommonMark parser that `mdast-util-from-markdown` runs, read the same
 * way it calls it. Tokens keep the exact offsets of what was written, such as a link's destination,
 * which the syntax tree only gives decoded.
 */
const eventsOf = (text: string) =>
  postprocess(parse({ extensions: [frontmatter()] }).document().write(preprocess()(text, undefined, true)));

const attributesIn = (html: string, offset: number): ReadonlyArray<LinkTarget> =>
  [...html.matchAll(HTML_ATTRIBUTE)].map((match) => {
    const target = match[1] ?? "";
    const from = offset + (match.index ?? 0) + match[0].length - target.length - 1;
    return { from, to: from + target.length, target };
  });

/** The text after the front matter's closing fence, without that fence's line break. */
const after = (text: string, end: number) => {
  const rest = text.slice(end);
  return rest.slice(rest.startsWith("\r\n") ? 2 : rest.startsWith("\n") || rest.startsWith("\r") ? 1 : 0);
};

/**
 * Reads a skill's file. Its link targets are the destinations of Markdown links, images, reference
 * definitions and autolinks, and the `src` and `href` of its raw HTML. A file that is not Markdown,
 * such as an HTML page, also has every `src` and `href` in its text read. A byte order mark is
 * dropped before the file is read, so offsets count from after it.
 */
export const readSkillMarkdown = (path: string, file: string): SkillMarkdown => {
  const text = file.startsWith(BOM) ? file.slice(1) : file;
  const markdown = path.toLowerCase().endsWith(".md");
  const links: Array<LinkTarget> = markdown ? [] : [...attributesIn(text, 0)];
  // Where the front matter's YAML starts and ends: from its first line to its last.
  const yaml = { from: -1, to: -1 };
  let frontMatterEnd: number | null = null;
  for (const [kind, token] of eventsOf(text)) {
    const from = token.start.offset;
    const to = token.end.offset;
    // The front matter extension's tokens are not in micromark's own list of token types.
    const type: string = token.type;
    if (type === "yaml" && kind === "exit") frontMatterEnd = to;
    if (kind !== "enter") continue;
    if (type === "yamlValue") {
      if (yaml.from === -1) yaml.from = from;
      yaml.to = to;
    }
    else if (DESTINATIONS.has(type)) links.push({ from, to, target: text.slice(from, to) });
    else if (markdown && HTML.has(type)) links.push(...attributesIn(text.slice(from, to), from));
  }
  return {
    frontMatter:
      frontMatterEnd === null
        ? null
        : { yaml: yaml.from === -1 ? "" : text.slice(yaml.from, yaml.to), rest: after(text, frontMatterEnd) },
    links: links.sort((a, b) => a.from - b.from),
  };
};

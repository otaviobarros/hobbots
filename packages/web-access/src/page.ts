/// <reference path="./turndown-plugin-gfm.d.ts" />
import { foundUrlKey, urlsIn, type WebLink } from "@hobbots/agents";
import { tables } from "@joplin/turndown-plugin-gfm";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

/**
 * A page's body as text a hob can act on (ADR 036): HTML through Mozilla's Readability on linkedom,
 * then turndown to Markdown with headings, lists, tables and links kept; plain text, Markdown and
 * JSON as the site sent them. No script on the page ever runs: linkedom builds a DOM and runs nothing.
 */

/** What a page reads as: its title, Markdown text and links. */
export interface ReadPage {
  readonly title: string | null;
  readonly text: string;
  readonly links: ReadonlyArray<WebLink>;
}

/** The kinds of body `web_fetch` reads, by their media type. */
export type PageKind = "html" | "text" | "markdown" | "json";

/** What kind of page a media type is, or null for one `web_fetch` does not read, such as a PDF or an image. */
export const pageKind = (mediaType: string): PageKind | null => {
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  if (mediaType === "text/markdown" || mediaType === "text/x-markdown") return "markdown";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "text/plain" || mediaType === "") return "text";
  return null;
};

/** A `Content-Type` header's media type and charset, lowercase. */
export const contentTypeOf = (
  header: string | undefined,
): { readonly mediaType: string; readonly charset?: string } => {
  const [type = "", ...params] = (header ?? "").split(";");
  const charset = params
    .map((param) => param.trim().split("="))
    .find(([name]) => name?.toLowerCase() === "charset")?.[1]
    ?.replace(/^"|"$/g, "")
    .toLowerCase();
  return { mediaType: type.trim().toLowerCase(), ...(charset === undefined ? {} : { charset }) };
};

/** The charset an HTML page names in its own `<meta>` near the top, when the header named none. */
const metaCharset = (body: Uint8Array): string | undefined =>
  /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(body.subarray(0, 4096)))?.[1];

/** The body as text in its charset, UTF-8 when it names none this platform knows. */
export const decodeBody = (body: Uint8Array, kind: PageKind, charset: string | undefined): string => {
  const label = charset ?? (kind === "html" ? metaCharset(body) : undefined) ?? "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
};

/** Elements that are never part of a page's text. */
const NEVER_TEXT = "script, style, noscript, template, iframe, object, embed, svg, canvas, link, meta";

/** Text squeezed onto one line and cut, for a link's label. */
const label = (text: string | null | undefined): string => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

const markdown = (): TurndownService => {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  service.use(tables);
  // An image is kept by its text and address, and dropped when it has neither, such as an inline `data:` one.
  service.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const src = node.getAttribute("src") ?? "";
      const alt = label(node.getAttribute("alt"));
      return /^https?:/i.test(src) ? `![${alt}](${src})` : alt;
    },
  });
  return service;
};

type Page = ReturnType<typeof parseHTML>["document"];

/** An HTML document, whole even when the site sent only a fragment. */
const documentOf = (html: string): Page => {
  const parsed = parseHTML(html).document;
  return parsed.documentElement === null
    ? parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document
    : parsed;
};

/**
 * Every link on the page made absolute, in the page itself so the text keeps them too, and the
 * http and https ones listed once each, with their text.
 */
const absoluteLinks = (document: Page, url: string): ReadonlyArray<WebLink> => {
  const base = document.querySelector("base[href]")?.getAttribute("href");
  let from = url;
  try {
    if (base) from = new URL(base, url).href;
  } catch {
    from = url;
  }
  const links = new Map<string, WebLink>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href") ?? "";
    let absolute: string;
    try {
      absolute = new URL(href, from).href;
    } catch {
      continue;
    }
    anchor.setAttribute("href", absolute);
    const key = foundUrlKey(absolute);
    if (key !== null && !links.has(key)) links.set(key, { url: key, text: label(anchor.textContent) });
  }
  for (const image of document.querySelectorAll("img[src]")) {
    try {
      image.setAttribute("src", new URL(image.getAttribute("src") ?? "", from).href);
    } catch {
      image.removeAttribute("src");
    }
  }
  return [...links.values()];
};

/** An HTML page's main text, or its whole body when Readability finds no article in it. */
const readHtml = (html: string, url: string): ReadPage => {
  const document = documentOf(html);
  for (const element of document.querySelectorAll(NEVER_TEXT)) element.remove();
  const links = absoluteLinks(document, url);
  const pageTitle = label(document.title) || null;
  const body = document.body?.innerHTML ?? "";
  // Readability changes the document it reads, so the body is kept as it was for a page with no article.
  const article = new Readability(document).parse();
  const text = markdown().turndown(article?.content ?? body);
  return { title: label(article?.title) || pageTitle, text, links };
};

/** A page's body as text, by its kind. */
export const readPage = (body: string, kind: PageKind, url: string): ReadPage => {
  switch (kind) {
    case "html":
      return readHtml(body, url);
    case "json": {
      let text = body;
      try {
        text = `\`\`\`json\n${JSON.stringify(JSON.parse(body), null, 2)}\n\`\`\``;
      } catch {
        text = body;
      }
      return { title: null, text, links: urlsIn(body).map((link) => ({ url: link, text: "" })) };
    }
    case "markdown":
    case "text":
      return { title: null, text: body, links: urlsIn(body).map((link) => ({ url: link, text: "" })) };
  }
};

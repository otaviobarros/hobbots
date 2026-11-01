import { cn } from "@hobbots/ui/lib/utils";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block.tsx";
import { codeLanguage, hastText } from "./hast-text.ts";
import { remarkHtmlAsText } from "./html-as-text.ts";
import { safeUrl } from "./links.ts";
import { ReplyImage, ReplyLink } from "./reply-media.tsx";
import { streamingMarkdown } from "./streaming.ts";

const heading = "font-pixel font-bold text-moonlight";

// Each element of a reply, styled with the design tokens (docs/design/ui-ux.md). Headings sit two
// levels down, so a reply's `#` never competes with the screen's own headings.
const components: Components = {
  h1: ({ node: _, ...props }) => <h3 className={cn(heading, "text-xl")} {...props} />,
  h2: ({ node: _, ...props }) => <h4 className={cn(heading, "text-lg")} {...props} />,
  h3: ({ node: _, ...props }) => <h5 className={cn(heading, "text-base")} {...props} />,
  h4: ({ node: _, ...props }) => <h6 className="font-bold" {...props} />,
  h5: ({ node: _, ...props }) => <h6 className="font-bold" {...props} />,
  h6: ({ node: _, ...props }) => <h6 className="font-bold text-secondary-text" {...props} />,
  ul: ({ node: _, className, ...props }) => (
    <ul
      className={cn(
        "flex list-[square] flex-col gap-1 ps-5 marker:text-label",
        className === "contains-task-list" && "list-none ps-0.5",
      )}
      {...props}
    />
  ),
  ol: ({ node: _, ...props }) => <ol className="flex list-decimal flex-col gap-1 ps-6 marker:text-label" {...props} />,
  input: ({ node: _, ...props }) => (
    <input
      className="me-2 size-3.5 cursor-default appearance-none border-2 border-control align-[-2px] checked:border-mint checked:bg-mint"
      {...props}
    />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote className="m-0 flex flex-col gap-2 bg-panel px-3 py-2 text-secondary-text" {...props} />
  ),
  hr: () => <hr className="h-0.5 w-full border-0 bg-line" />,
  table: ({ node: _, ...props }) => (
    <div className="max-w-full overflow-x-auto">
      <table className="border-collapse text-sm" {...props} />
    </div>
  ),
  th: ({ node: _, style, ...props }) => (
    <th
      className="border-2 border-line bg-panel px-3 py-1.5 text-start font-bold text-label"
      style={style}
      {...props}
    />
  ),
  td: ({ node: _, ...props }) => <td className="border-2 border-line px-3 py-1.5 align-top" {...props} />,
  del: ({ node: _, ...props }) => <del className="text-label" {...props} />,
  strong: ({ node: _, ...props }) => <strong className="font-bold" {...props} />,
  code: ({ node: _, className, ...props }) => (
    <code className={cn("bg-deep px-1 py-px font-mono text-[0.9em]", className)} {...props} />
  ),
  pre: ({ node, children }) => (
    <CodeBlock language={node ? codeLanguage(node) : null} text={node ? hastText(node).replace(/\n$/, "") : ""}>
      {children}
    </CodeBlock>
  ),
  a: ({ href, node, children }) => (
    <ReplyLink href={href} node={node}>
      {children}
    </ReplyLink>
  ),
  img: ({ src, alt }) => <ReplyImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

/**
 * A hob's reply, formatted from its Markdown: CommonMark with GitHub tables, task lists and
 * strikethrough. HTML shows as text, links only reach web addresses, and code is highlighted.
 * While it streams, unfinished syntax is held back or closed, so the layout never flickers.
 */
export function ReplyMarkdown({
  content,
  streaming,
  caret,
}: {
  content: string;
  /** The reply is still in progress, so unfinished syntax is held back or closed. */
  streaming: boolean;
  /** The reply is being written now, so the caret follows its last line. */
  caret: boolean;
}) {
  return (
    <div className={cn("hb-markdown flex min-w-0 flex-col gap-2.5 leading-normal break-words", caret && "hb-caret")}>
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm, remarkHtmlAsText]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        urlTransform={safeUrl}
      >
        {streaming ? streamingMarkdown(content) : content}
      </Markdown>
    </div>
  );
}

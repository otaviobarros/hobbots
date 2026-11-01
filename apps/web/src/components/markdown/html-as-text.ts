/**
 * The parts of a Markdown syntax tree (mdast) this plugin touches. HTML in a reply is never
 * rendered: each `html` node becomes plain text that shows the tags as written.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

// Containers whose children are blocks; HTML there becomes its own paragraph.
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

const asText = (node: MdNode, parentType: string): MdNode => {
  const text: MdNode = { type: "text", value: node.value ?? "" };
  if (!BLOCK_PARENTS.has(parentType)) return text;
  // A block keeps its line breaks, so a pasted snippet reads as it was written.
  return { type: "paragraph", children: [text], data: { hProperties: { className: ["whitespace-pre-wrap"] } } };
};

const visit = (node: MdNode) => {
  if (!node.children) return;
  node.children = node.children.map((child) => {
    if (child.type === "html") return asText(child, node.type);
    visit(child);
    return child;
  });
};

/** A remark plugin that shows raw HTML in Markdown as text instead of rendering it. */
export const remarkHtmlAsText = () => (tree: MdNode) => {
  visit(tree);
};

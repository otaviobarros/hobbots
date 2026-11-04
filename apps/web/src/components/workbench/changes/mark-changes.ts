import type { BlockMark } from "./changes-model.ts";

/** The parts of a Markdown syntax tree (mdast) this plugin touches. */
interface MdNode {
  type: string;
  position?: { readonly start: { readonly offset?: number | undefined } } | undefined;
  children?: MdNode[] | undefined;
  data?: object | undefined;
}

/** Blocks that render nothing where they stand, so marking them would show an empty highlight. */
const UNSEEN = new Set(["definition", "footnoteDefinition"]);

// Removed text is struck through in rose; new text sits on a mint wash.
const tone: Record<BlockMark, string> = {
  added: "bg-mint/16 no-underline",
  removed: "bg-rose/16 line-through decoration-rose/70",
};

/**
 * Wraps a changed top-level block in `<ins>` or `<del>`, filled with its mark's tone, with a
 * spoken "Added:" or "Removed:" first. The wrapper is a node of its own that remark-rehype turns
 * into its `hName`, so the block itself, and every reference it holds, renders as it would anyway.
 */
const wrap = (node: MdNode, mark: BlockMark, label: string): MdNode => ({
  type: "changedBlock",
  data: {
    hName: mark === "added" ? "ins" : "del",
    hProperties: { className: ["block", "rounded-sm", "px-1.5", "py-0.5", "-mx-1.5", ...tone[mark].split(" ")] },
  },
  children: [
    {
      type: "changeLabel",
      data: { hName: "span", hProperties: { className: ["sr-only"] }, hChildren: [{ type: "text", value: label }] },
    },
    node,
  ],
});

/**
 * A remark plugin that marks the top-level blocks of a document the change added or removed, found
 * by where each starts in the text (ADR 023). It runs on the whole document, so links, images and
 * footnotes keep the definitions they refer to elsewhere in it.
 */
export const remarkMarkChanges =
  (marks: ReadonlyMap<number, BlockMark>, labels: Readonly<Record<BlockMark, string>>) => () => (tree: MdNode) => {
    if (tree.children === undefined) return;
    tree.children = tree.children.map((node) => {
      const mark = node.position?.start.offset === undefined ? undefined : marks.get(node.position.start.offset);
      return mark === undefined || UNSEEN.has(node.type) ? node : wrap(node, mark, labels[mark]);
    });
  };

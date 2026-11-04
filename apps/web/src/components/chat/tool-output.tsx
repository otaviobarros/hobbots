import type { ToolOutput } from "@hobbots/domain";
import { cn } from "@hobbots/ui/lib/utils";
import type { ReactNode } from "react";
import { formatBytes } from "../../lib/format.ts";
import { messages } from "../messages.ts";

const copy = messages.steps;

/** Monospace output on the deep ground, each part scrolling past 240px. */
export const OUTPUT_TEXT =
  "m-0 max-h-60 overflow-auto px-2.5 py-2 font-mono text-xs leading-normal whitespace-pre-wrap break-all";

/**
 * What a tool call or command printed, already redacted. Long output shows its start and its end,
 * where the error usually is, with how much was left out between them; `whole` says where the
 * whole of it is, or why it is not.
 */
export function OutputBlock({
  output,
  whole,
  className,
}: {
  output: ToolOutput;
  /** The link to the whole log, or why it cannot be opened; shown only when part was left out. */
  whole: ReactNode;
  className?: string;
}) {
  const cut = output.omittedBytes > 0;
  return (
    <figure
      aria-label={copy.output}
      className={cn("m-0 flex min-w-0 flex-col border-2 border-line bg-deep", className)}
    >
      <figcaption className="border-b-2 border-line px-2.5 py-1 text-xs text-label">{copy.output}</figcaption>
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area takes the focus so the keyboard can scroll it (WCAG 2.1.1).
        tabIndex={0}
        className={OUTPUT_TEXT}
      >
        {output.head}
      </pre>
      {cut && (
        <>
          <p className="m-0 border-y-2 border-dashed border-line px-2.5 py-1 text-center text-xs text-label">
            {copy.omitted({ size: formatBytes(output.omittedBytes) })}
          </p>
          {/* Reversed, so the end, where an error usually is, shows first and the rest scrolls up. */}
          <div
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area takes the focus so the keyboard can scroll it (WCAG 2.1.1).
            tabIndex={0}
            className="flex max-h-60 flex-col-reverse overflow-auto"
          >
            <pre className={cn(OUTPUT_TEXT, "max-h-none overflow-visible")}>{output.tail}</pre>
          </div>
          <p className="m-0 border-t-2 border-line px-2.5 py-1 text-xs">{whole}</p>
        </>
      )}
    </figure>
  );
}

/** The link that opens a whole log as plain text in a new tab. */
export function LogLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-lantern underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

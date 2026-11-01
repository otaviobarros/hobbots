import { Button } from "@hobbots/ui/components/button";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { messages } from "./messages.ts";

const copy = messages.code;

type CopyState = "idle" | "copied" | "failed";

/** How long "Copied" shows before the button reads "Copy" again. */
const COPIED_FOR_MS = 1500;

/** A fenced code block: its language, a Copy button, and the highlighted code. */
export function CodeBlock({
  language,
  text,
  children,
}: {
  language: string | null;
  text: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The reset timer is cleared when the block leaves the page.
  useEffect(() => () => clearTimeout(reset.current), []);

  const settle = (next: CopyState) => {
    setState(next);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setState("idle"), COPIED_FOR_MS);
  };
  const onCopy = () => {
    // The clipboard exists only in a secure context; a browser on another device may not have it.
    if (navigator.clipboard === undefined) return settle("failed");
    navigator.clipboard.writeText(text).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  };
  const label = language === null ? copy.plain : copy.label({ language });
  return (
    <figure aria-label={label} className="m-0 flex min-w-0 flex-col border-2 border-line bg-deep">
      <figcaption className="flex items-center justify-between gap-3 border-b-2 border-line py-1 ps-3 pe-1">
        <span className="text-xs text-label">{language ?? copy.plain}</span>
        <Button variant="ghost" size="xs" onClick={onCopy}>
          {state === "idle" ? copy.copy : state === "copied" ? copy.copied : copy.copyFailed}
        </Button>
        <span role="status" className="sr-only">
          {state === "copied" ? copy.copied : state === "failed" ? copy.copyFailed : ""}
        </span>
      </figcaption>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[13px] leading-normal [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[length:inherit]">
        {children}
      </pre>
    </figure>
  );
}

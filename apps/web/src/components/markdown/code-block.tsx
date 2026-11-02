import { Button } from "@hobbots/ui/components/button";
import type { ReactNode } from "react";
import { useCopy } from "../../lib/use-copy.ts";
import { messages } from "./messages.ts";

const copy = messages.code;

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
  const [state, copyText] = useCopy();
  const onCopy = () => copyText(text);
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

import { Button } from "@hobbots/ui/components/button";
import { messages } from "./messages.ts";

/** A read that failed, in its section's place, with Try again. */
export function ReadFailed({ text, retry }: { text: string; retry: () => void }) {
  return (
    <p role="alert" className="m-0 flex flex-wrap items-center gap-3 text-ui text-rose">
      {text}
      <Button variant="outline" size="xs" onClick={retry}>
        {messages.tryAgain}
      </Button>
    </p>
  );
}

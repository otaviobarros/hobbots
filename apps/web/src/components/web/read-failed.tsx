import { Button } from "@hobbots/ui/components/button";
import { messages } from "./messages.ts";

/** A web read that failed (STD-REACT-015, STD-UI-009): what could not be read, and Try again. */
export function ReadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-3 text-ui text-text-secondary">
      <span role="alert">{text}</span>
      <Button type="button" variant="chip" size="xs" onClick={onRetry}>
        {messages.retry}
      </Button>
    </p>
  );
}

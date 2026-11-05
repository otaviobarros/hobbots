import { Button } from "@hobbots/ui/components/button";
import { useId, useState } from "react";
import { memoryNotAnswering, memoryPageChanged } from "../../api/memory-pages.ts";
import type { Say } from "./memory-actions.tsx";
import { houseRuleOf } from "./memory-edit-model.ts";
import { messages } from "./messages.ts";
import type { MemoryWrites } from "./use-memory-writes.ts";

const copy = messages;

/**
 * About you's composer (#959): a house rule every hob follows, kept as a rule page of About you,
 * written by you. A rule that did not save stays in the field.
 */
export function HouseRuleForm({ writes, say }: { writes: MemoryWrites; say: Say }) {
  const id = useId();
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const empty = text.trim() === "";
  return (
    <form
      aria-label={copy.about.newRule}
      onSubmit={(event) => {
        event.preventDefault();
        if (empty) return;
        setFailure(null);
        writes.save.mutate(houseRuleOf(text), {
          onSuccess: () => {
            setText("");
            say({ tone: "done", message: copy.about.added });
          },
          onError: (error) =>
            setFailure(
              memoryPageChanged(error)
                ? copy.editor.taken
                : memoryNotAnswering(error)
                  ? copy.editor.notAnswering
                  : copy.editor.failed,
            ),
        });
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2 rounded-card border-(length:--edge) border-control bg-card py-2 ps-3 pe-2 focus-within:shadow-[0_0_0_2px_var(--color-ring)]">
        <label htmlFor={id} className="sr-only">
          {copy.about.newRule}
        </label>
        <input
          id={id}
          type="text"
          value={text}
          placeholder={copy.about.rulePlaceholder}
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-body text-text-strong outline-none placeholder:text-label"
        />
        <Button type="submit" size="sm" disabled={empty || writes.save.isPending}>
          {writes.save.isPending ? copy.about.adding : copy.about.add}
        </Button>
      </div>
      {failure !== null && (
        <p role="alert" className="m-0 text-ui text-rose">
          {failure}
        </p>
      )}
    </form>
  );
}

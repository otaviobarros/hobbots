import { messages } from "./messages.ts";

const copy = messages.keys;

/** The keys Needs you answers to, as a line of keycaps under the list. */
export function InboxKeyHints() {
  return (
    <p className="m-0 flex flex-none flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-4 py-2 text-meta text-label">
      {copy.hints.map(({ keys, does }) => (
        <span key={does} className="flex items-center gap-1">
          {keys.map((key) => (
            <kbd
              key={key}
              className="min-w-4.5 rounded-tag border border-b-(length:--edge) border-line-2 bg-card px-1 text-center font-sans text-meta text-text-secondary"
            >
              {key}
            </kbd>
          ))}
          {does}
        </span>
      ))}
    </p>
  );
}

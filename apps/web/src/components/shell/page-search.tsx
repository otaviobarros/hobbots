import { SearchField } from "@hobbots/ui/components/search-field";
import { useState } from "react";

/**
 * The search in a page's header. Enter searches what was typed; clearing it while a search shows
 * ends the search. A search opened from elsewhere, such as Back, shows its own words.
 */
export function PageSearch({
  asked,
  copy: { label, placeholder, clear: clearLabel },
  onSearch,
  onClear,
}: {
  /** The search the page shows now, "" for none. */
  asked: string;
  /** The search's name, the hint in the empty box, and the name of its clear button. */
  copy: { readonly label: string; readonly placeholder: string; readonly clear: string };
  /** Called with the trimmed text, "" when it was cleared. */
  onSearch: (q: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(asked);
  const [shownFor, setShownFor] = useState(asked);
  if (shownFor !== asked) {
    setShownFor(asked);
    setDraft(asked);
  }
  return (
    <search aria-label={label} className="w-[300px] max-[1180px]:w-[220px]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearch(draft.trim());
        }}
      >
        <SearchField
          aria-label={label}
          placeholder={placeholder}
          clearLabel={clearLabel}
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            if (next === "" && asked !== "") onClear();
          }}
        />
      </form>
    </search>
  );
}

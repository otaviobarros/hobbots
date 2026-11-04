import * as React from "react";
import { cn } from "../lib/utils.ts";

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.tsx";

type SearchFieldProps = Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the clear button, from the caller's messages (STD-I18N-001). */
  clearLabel: string;
  /** Esc on an empty field, for example to close a search bar. Esc with text clears it instead. */
  onEscape?: () => void;
  /** Shown before the clear button, such as a match count. */
  trailing?: React.ReactNode;
  /**
   * Whether "/" anywhere on the page focuses the field, with the "/" keycap shown while it is
   * empty. On by default; a field that opens already focused, such as a search bar, turns it off.
   */
  slashKey?: boolean;
  /** Whether text shows a clear button. Turn it off when `trailing` already holds a close button. */
  clearButton?: boolean;
  /** Classes for the field's frame. Other props go to the input. */
  className?: string;
};

// Corners, edge width and easing read the theme's skin variables (docs/design/themes.md).
const frame =
  "h-auto rounded-control border-[length:var(--edge)] border-line-2 bg-deep transition-colors duration-(--dur-fade) ease-[var(--ease-ui)] hover:border-control dark:bg-deep";

const input = "h-auto py-2 text-ui text-text placeholder:text-label [&::-webkit-search-cancel-button]:appearance-none";

const clear = "size-hit-min rounded-control text-label [clip-path:none] hover:bg-hover hover:text-text-strong";

const keycap = "rounded-[4px] border border-line-2 px-[5px] font-sans text-xs leading-4 text-label";

const SLASH = "/";

/** Whether a key press belongs to whatever has focus, so "/" types there instead of jumping. */
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, select, [contenteditable=true]") !== null);

/**
 * "/" focuses the field, unless something else takes the key: a field being typed in, a shortcut
 * with a modifier, another search field that answered first, or a dialog that hides this one.
 */
function useSlashFocus(target: React.RefObject<HTMLInputElement | null>, enabled: boolean) {
  React.useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const field = target.current;
      if (event.key !== SLASH || event.defaultPrevented || field === null || field.disabled) return;
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
      if (field.closest("[aria-hidden=true], [inert]") !== null) return;
      event.preventDefault();
      field.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [target, enabled]);
}

/**
 * A search input with a magnifier, a clear button and the "/" hint. Esc clears the text, then calls
 * `onEscape`; "/" elsewhere on the page focuses it.
 */
function SearchField({
  value,
  onValueChange,
  clearLabel,
  onEscape,
  trailing,
  slashKey = true,
  clearButton = true,
  className,
  onKeyDown,
  disabled,
  ref,
  ...props
}: SearchFieldProps) {
  const field = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(ref, () => field.current as HTMLInputElement);
  useSlashFocus(field, slashKey);
  const hint = slashKey && value === "" && !disabled;
  const clears = clearButton && value !== "" && !disabled;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    if (value === "") {
      onEscape?.();
      return;
    }
    // Clearing is the whole answer to this Esc, so a dialog or sheet around the field stays open.
    event.stopPropagation();
    onValueChange("");
  };

  const handleClear = () => {
    onValueChange("");
    field.current?.focus();
  };

  return (
    <InputGroup className={cn(frame, className)}>
      <InputGroupAddon className="py-0 ps-2.5 text-label">
        <MagnifierIcon />
      </InputGroupAddon>
      <InputGroupInput
        {...props}
        ref={field}
        type="search"
        aria-keyshortcuts={slashKey ? SLASH : undefined}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={input}
      />
      {(trailing !== undefined || hint || clears) && (
        <InputGroupAddon align="inline-end" className="gap-1.5 py-0 pe-1 text-label">
          {trailing}
          {hint && (
            // The input names its shortcut with aria-keyshortcuts, so the keycap is only seen.
            <span aria-hidden="true" className="me-1.5 flex">
              <kbd className={keycap}>{SLASH}</kbd>
            </span>
          )}
          {clears && (
            <InputGroupButton
              size="icon-xs"
              aria-label={clearLabel}
              title={clearLabel}
              onClick={handleClear}
              className={clear}
            >
              <ClearIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

function MagnifierIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="size-3.5"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export { SearchField, type SearchFieldProps };

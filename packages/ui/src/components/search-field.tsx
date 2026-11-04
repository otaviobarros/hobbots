import type * as React from "react";
import { cn } from "../lib/utils.ts";

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.tsx";

type SearchFieldProps = Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the clear button, from the caller's messages (STD-I18N-001). */
  clearLabel: string;
  /** Esc on an empty field, for example to close a search bar. Esc with text clears it instead. */
  onEscape?: () => void;
  /** Shown before the clear button, such as a match count or a key hint. */
  trailing?: React.ReactNode;
  /** Classes for the field's frame. Other props go to the input. */
  className?: string;
};

// Corners, edge width and easing read the theme's skin variables (docs/design/themes.md).
const frame =
  "h-auto rounded-control border-[length:var(--edge)] border-line-2 bg-deep transition-colors duration-150 ease-[var(--ease-ui)] hover:border-control dark:bg-deep has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20";

const input =
  "h-auto py-2 text-ui leading-5 text-text placeholder:text-label md:text-ui [&::-webkit-search-cancel-button]:appearance-none";

const clear = "size-hit-min rounded-control text-label [clip-path:none] hover:bg-hover hover:text-text-strong";

/** A search input with a magnifier and a clear button. Esc clears the text, then calls `onEscape`. */
function SearchField({
  value,
  onValueChange,
  clearLabel,
  onEscape,
  trailing,
  className,
  onKeyDown,
  disabled,
  ...props
}: SearchFieldProps) {
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

  const handleClear = (event: React.MouseEvent<HTMLButtonElement>) => {
    onValueChange("");
    event.currentTarget.closest("[data-slot=input-group]")?.querySelector("input")?.focus();
  };

  return (
    <InputGroup className={cn(frame, className)}>
      <InputGroupAddon className="py-0 ps-2.5 text-label">
        <MagnifierIcon />
      </InputGroupAddon>
      <InputGroupInput
        {...props}
        type="search"
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={input}
      />
      {(trailing !== undefined || value !== "") && (
        <InputGroupAddon align="inline-end" className="gap-1.5 py-0 pe-1 text-label">
          {trailing}
          {value !== "" && !disabled && (
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

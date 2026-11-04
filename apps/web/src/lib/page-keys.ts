/** Whether the element takes text, so a key pressed there types rather than acting on the page. */
export const isTextField = (element: Element | null): boolean => {
  if (element === null) return false;
  if ((element as { isContentEditable?: boolean }).isContentEditable === true) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = (element as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(type);
};

/** The parts of a key press a page shortcut reads. */
export interface KeyPress {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
}

/** Widgets that move with the arrow keys themselves, and dialogs and menus over the page. */
const OWNS_KEYS =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="radiogroup"],[role="radio"],[role="tablist"]';

/**
 * Whether a single-key shortcut such as J or A may act on this press: no modifier (⌥↑ and ⌥↓ move
 * between chats), nothing handled it already, it is not typed into a field, and it is not inside a
 * widget, dialog or menu that handles keys itself.
 */
export const isPageKey = (press: KeyPress): boolean => {
  if (press.defaultPrevented || press.altKey || press.ctrlKey || press.metaKey) return false;
  const target = press.target as (Element & { closest?: unknown }) | null;
  if (target === null || typeof target.closest !== "function") return true;
  return !isTextField(target) && target.closest(OWNS_KEYS) === null;
};

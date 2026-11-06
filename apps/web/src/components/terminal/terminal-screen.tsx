import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import { type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef } from "react";
import { HIDE_CURSOR } from "./ansi.ts";
import { type SearchResult, searchDecorations, THEME_TOKENS } from "./terminal-options.ts";
import { terminalWrite } from "./terminal-sync.ts";

/** What a screen's owner can ask of it: find text in it, and clear what was found. */
export interface TerminalHandle {
  readonly find: (term: string, direction: "next" | "previous") => void;
  readonly clearFind: () => void;
}

interface TerminalScreenProps {
  /** The screen's accessible name, such as "Ada's terminal". */
  readonly label: string;
  /**
   * Everything the screen shows, as a terminal would print it. It may only grow, or change its last
   * line, to be written in place; any other change writes it afresh.
   */
  readonly content: string;
  /** Opens a link the content holds; links it does not open do nothing. */
  readonly onLink: (url: string) => void;
  /** Asks the owner to show its search field, for Cmd+F or Ctrl+F in the screen. */
  readonly onFind: () => void;
  /** Hears how many matches the last find had, and which one is picked. */
  readonly onResults: (result: SearchResult) => void;
  readonly ref?: Ref<TerminalHandle>;
}

/** The terminal's colors, read from the `--color-term-*` tokens, which are the same in every theme. */
const themeOf = (element: HTMLElement): ITheme => {
  const style = getComputedStyle(element);
  const read = (token: string) => style.getPropertyValue(`--color-term-${token}`).trim();
  return Object.fromEntries(Object.entries(THEME_TOKENS).map(([key, token]) => [key, read(token)]));
};

/**
 * One terminal (#908), built on xterm.js and loaded only when a Terminal first opens. It is a
 * record you read, select, copy and search: it takes no input and shows no cursor, and Tab and
 * Escape leave it as they leave anything else. Screen reader mode lets a screen reader read its
 * rows. A later live terminal can give it a session's output as `content` the same way.
 */
export function TerminalScreen({ label, content, onLink, onFind, onResults, ref }: TerminalScreenProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<{ readonly term: Terminal; readonly search: SearchAddon; shown: string } | null>(null);
  // Called by xterm.js, so each sees the latest props without making the terminal again.
  const openLink = useEffectEvent(onLink);
  const askToFind = useEffectEvent(onFind);
  const hearResults = useEffectEvent(onResults);

  useImperativeHandle(
    ref,
    () => ({
      find: (term, direction) => {
        const search = terminal.current?.search;
        const options = { decorations: searchDecorations(host.current) };
        if (direction === "next") search?.findNext(term, options);
        else search?.findPrevious(term, options);
      },
      clearFind: () => terminal.current?.search.clearDecorations(),
    }),
    [],
  );

  // xterm.js lives outside React: it is made once with the screen and fits the screen as it resizes.
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      disableStdin: true,
      // Search marks its matches with decorations, which xterm.js still calls a proposed API.
      allowProposedApi: true,
      screenReaderMode: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: 10_000,
      // Colors a command picked for a light terminal are raised to read on this dark one.
      minimumContrastRatio: 4.5,
      fontFamily: getComputedStyle(element).getPropertyValue("--font-mono").trim(),
      fontSize: 13,
      lineHeight: 1.35,
      theme: themeOf(element),
      linkHandler: { activate: (_event, url) => openLink(url) },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.attachCustomKeyEventHandler((event) => {
      // Tab and Escape leave the terminal as they leave anything else on the page.
      if (event.key === "Tab" || event.key === "Escape") return false;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (event.type === "keydown") {
          event.preventDefault();
          askToFind();
        }
        return false;
      }
      return true;
    });
    const results = search.onDidChangeResults((each) => hearResults(each));
    term.open(element);
    term.textarea?.setAttribute("aria-label", label);
    term.write(HIDE_CURSOR);
    terminal.current = { term, search, shown: "" };
    const resize = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit();
    });
    resize.observe(element);
    return () => {
      resize.disconnect();
      results.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [label]);

  // The content is written as it grows, so a live command's output shows as it comes.
  useEffect(() => {
    const current = terminal.current;
    if (current === null) return;
    const write = terminalWrite(current.shown, content, current.term.cols);
    if (write.kind === "reset") {
      current.term.reset();
      current.term.write(HIDE_CURSOR + write.data);
    } else if (write.kind === "append") {
      current.term.write(write.data);
    }
    current.shown = content;
  });

  // The fit addon sizes the terminal to its parent's height padding included, so the padding sits
  // on a frame around that parent, and the rows never run past the bottom.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 py-2 ps-2.5">
      <div ref={host} data-slot="terminal-screen" className="min-h-0 min-w-0 flex-1" />
    </div>
  );
}

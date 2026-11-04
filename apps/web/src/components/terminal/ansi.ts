/**
 * Building and cleaning text for the terminal (#908). Lines the app writes use SGR sequences from
 * the terminal's own 16-color palette, so they follow its theme. What a command printed is kept as
 * printed, colors included, but only the sequences that style or tidy a line survive: anything that
 * moves the cursor, clears the screen, switches buffers or sets a title or link is dropped, so a
 * command cannot rewrite the lines around it or the record of another.
 */

const ESC = "\u001b";

/** An SGR sequence: `sgr(31)` turns text red, `sgr(0)` resets every attribute. */
const sgr = (...codes: ReadonlyArray<number>) => `${ESC}[${codes.join(";")}m`;

/** The styles the app's own lines use, each with the reset that ends it. */
export const style = {
  bold: (text: string) => `${sgr(1)}${text}${sgr(0)}`,
  dim: (text: string) => `${sgr(90)}${text}${sgr(0)}`,
  green: (text: string) => `${sgr(32)}${text}${sgr(0)}`,
  red: (text: string) => `${sgr(31)}${text}${sgr(0)}`,
  yellow: (text: string) => `${sgr(33)}${text}${sgr(0)}`,
};

/** Resets every attribute, so a command's colors stop where its output ends. */
export const RESET = sgr(0);

/** Hides the cursor: a record has no place to type. */
export const HIDE_CURSOR = `${ESC}[?25l`;

/** Goes back to the start of the line and clears it. */
export const CLEAR_LINE = `\r${ESC}[2K`;

/** An OSC 8 hyperlink: the terminal opens `url` when `text` is clicked. */
export const link = (url: string, text: string) => `${ESC}]8;;${url}\u0007${text}${ESC}]8;;\u0007`;

const BEL = 0x07;
const ESC_CODE = 0x1b;

const between = (code: number, low: number, high: number) => code >= low && code <= high;

/**
 * Where the escape sequence that starts at `at` ends: a CSI sequence after its final byte, an OSC,
 * DCS, SOS, PM or APC string after its terminator (BEL or ST, or the end when it is cut), and any
 * other escape after its one byte.
 */
const escapeEnd = (text: string, at: number): number => {
  const kind = text[at + 1];
  if (kind === "[") {
    let end = at + 2;
    while (end < text.length && between(text.charCodeAt(end), 0x30, 0x3f)) end++;
    while (end < text.length && between(text.charCodeAt(end), 0x20, 0x2f)) end++;
    return end < text.length && between(text.charCodeAt(end), 0x40, 0x7e) ? end + 1 : end;
  }
  if (kind !== undefined && "]PX^_".includes(kind)) {
    for (let end = at + 2; end < text.length; end++) {
      if (text.charCodeAt(end) === BEL) return end + 1;
      if (text.charCodeAt(end) === ESC_CODE && text[end + 1] === "\\") return end + 2;
    }
    return text.length;
  }
  return Math.min(at + 2, text.length);
};

/** Whether a sequence styles text (SGR) or erases in a line (EL), which a progress bar uses. */
const styles = (sequence: string) => sequence.startsWith(`${ESC}[`) && /^\[[0-9;:]*[mK]$/.test(sequence.slice(1));

/** C0 controls besides tab, line feed, carriage return and backspace, and DEL, which are dropped. */
const dropped = (code: number) =>
  (code < 0x20 && code !== 0x08 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;

/** The text with each escape sequence kept when `keep` says so and every other control dropped. */
const filtered = (text: string, keep: (sequence: string) => boolean): string => {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === ESC_CODE) {
      const end = escapeEnd(text, at);
      const sequence = text.slice(at, end);
      if (keep(sequence)) out += sequence;
      at = end;
    } else {
      if (!dropped(code)) out += text[at];
      at++;
    }
  }
  return out;
};

/**
 * What a command printed, safe to write between the app's lines: SGR (colors and weight) and EL
 * (erase in line, which progress bars use with a carriage return) are kept, every other escape and
 * control character is dropped.
 */
export const printable = (text: string): string => filtered(text, styles);

/** The text a line shows, without its escape sequences, as a terminal would lay it out. */
export const visible = (text: string): string => filtered(text, () => false);

/** Unicode's picture of each C0 control starts here: ␀ for NUL, ␛ for ESC; DEL has ␡. */
const CONTROL_PICTURES = 0x2400;
const DEL = 0x7f;

/**
 * Text the app writes itself, such as a command line, a hob's name or a folder, shown as typed:
 * each control character but tab, an escape among them, shows as its picture (`␛[2J`), so it
 * reads as text and never moves the cursor, clears the screen or restyles the line.
 */
export const literal = (text: string): string => {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === DEL) out += "\u2421";
    else if (code < 0x20 && code !== 0x09) out += String.fromCharCode(CONTROL_PICTURES + code);
    else out += char;
  }
  return out;
};

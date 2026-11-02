/**
 * Shared locale formatters for counts, plurals and dates (STD-I18N-002, STD-I18N-003). `locale` is the
 * reader's, or the browser's when absent.
 */

/** A count in the reader's locale: "1,240". */
export const formatCount = (count: number, locale?: string): string => new Intl.NumberFormat(locale).format(count);

/** The form of a message that fits the count, chosen by the locale's plural rules. */
export const plural = <T>(count: number, forms: { readonly one: T; readonly other: T }, locale?: string): T =>
  new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;

/** A time ahead, relative to now, in the reader's locale: "in 23 hours", "in 5 minutes". */
export const formatIn = (value: number, unit: "minute" | "hour", locale?: string): string =>
  new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);

/** A day in the reader's locale: "Nov 2, 2026". */
export const formatDay = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

/** The first line of a text, trimmed: the title of a brief, or the gist of a longer note. */
export const firstLine = (text: string): string => text.split("\n", 1)[0]?.trim() ?? "";

/** Names joined as a list in the reader's locale: "Quill, Ada and Pip". */
export const formatList = (items: ReadonlyArray<string>, locale?: string): string =>
  new Intl.ListFormat(locale, { type: "conjunction" }).format(items);

const AGO_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

/** A time past, relative to now, in the reader's locale: "2 hours ago", "yesterday", "now" under a minute. */
export const formatAgo = (iso: string, now: Date = new Date(), locale?: string): string => {
  const elapsed = Math.max(0, now.getTime() - new Date(iso).getTime());
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of AGO_UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(0, "second");
};

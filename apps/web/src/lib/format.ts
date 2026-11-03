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

/** A day and time in the reader's locale: "Nov 2, 2026, 3:05 PM". */
export const formatMoment = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

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

type DurationUnit = "second" | "minute" | "hour";

const unitFormat = (unit: DurationUnit, value: number, locale?: string, fraction = 0) =>
  new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: fraction }).format(
    value,
  );

/** A whole count of `big` units and the `small` ones left over, the leftover left out when none. */
const twoUnits = (total: number, per: number, big: DurationUnit, small: DurationUnit, locale?: string) => {
  const rest = total % per;
  const whole = unitFormat(big, Math.floor(total / per), locale);
  return rest === 0 ? whole : `${whole} ${unitFormat(small, rest, locale)}`;
};

/**
 * How long something took, in the reader's locale, to the second: "0.4 sec" under a second (at least 0.1 sec), "12 sec",
 * "3 min 4 sec", "1 hr 5 min" past an hour.
 */
export const formatDuration = (ms: number, locale?: string): string => {
  const elapsed = Math.max(0, ms);
  // Anything that took time reads at least 0.1 sec, so a quick command never reads as taking none.
  if (elapsed < 1000)
    return unitFormat("second", elapsed === 0 ? 0 : Math.max(1, Math.round(elapsed / 100)) / 10, locale, 1);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return unitFormat("second", seconds, locale);
  if (seconds < 3600) return twoUnits(seconds, 60, "minute", "second", locale);
  return twoUnits(Math.floor(seconds / 60), 60, "hour", "minute", locale);
};

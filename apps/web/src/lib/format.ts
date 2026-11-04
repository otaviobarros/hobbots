/**
 * Shared locale formatters for counts, plurals and dates (STD-I18N-002, STD-I18N-003). `locale` is the
 * reader's, or the browser's when absent.
 */

/** A count in the reader's locale: "1,240". */
export const formatCount = (count: number, locale?: string): string => new Intl.NumberFormat(locale).format(count);

/** A large count, shortened in the reader's locale: "12K", "1.4M". */
export const formatCompact = (count: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(count);

/** A share out of 100 in the reader's locale: "38%". */
export const formatPercent = (percent: number, locale?: string): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(percent / 100);

/** An amount in minor units of `currency` (cents for USD), in the reader's locale: "$12.50". */
export const formatMoney = (minor: number, currency: string, locale?: string): string => {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
};

/** The form of a message that fits the count, chosen by the locale's plural rules. */
export const plural = <T>(count: number, forms: { readonly one: T; readonly other: T }, locale?: string): T =>
  new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;

/** A time ahead, relative to now, in the reader's locale: "in 23 hours", "in 5 minutes". */
export const formatIn = (value: number, unit: "minute" | "hour", locale?: string): string =>
  new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);

/** A day in the reader's locale: "Nov 2, 2026". */
export const formatDay = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

/** A day's weekday in the reader's locale: "Tuesday". */
export const formatWeekday = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(iso));

/** A day and time in the reader's locale: "Nov 2, 2026, 3:05 PM". */
export const formatMoment = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** A time of day in the reader's locale: "4:10 PM". */
export const formatTime = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(iso));

/** A weekday, day and time in the reader's locale: "Monday, Nov 9, 9:00 AM". */
export const formatWeekdayTime = (iso: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

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

const UNITS = [
  { unit: "byte", size: 1 },
  { unit: "kilobyte", size: 1024 },
  { unit: "megabyte", size: 1024 * 1024 },
  { unit: "gigabyte", size: 1024 * 1024 * 1024 },
] as const;

/**
 * A size in the reader's locale, in the largest unit that keeps it at 1 or more: "960 bytes", "12 kB",
 * "3.4 MB". Bytes are spelled out, since the short form has no plural ("960 byte").
 */
export const formatBytes = (bytes: number, locale?: string): string => {
  const { unit, size } = UNITS.findLast((candidate) => bytes >= candidate.size) ?? UNITS[0];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: unit === "byte" ? "long" : "short",
    maximumFractionDigits: unit === "byte" ? 0 : 1,
  }).format(bytes / size);
};

/** A day of the month in the reader's locale: "Oct 2". */
export const formatMonthDay = (date: Date, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);

/** A weekday and date in the reader's locale, with the year when asked: "Sun, Nov 1", "Tue, Dec 30, 2025". */
export const formatWeekdayDate = (date: Date, withYear: boolean, locale?: string): string =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(date);

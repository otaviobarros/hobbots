/**
 * Shared locale formatters for counts and plurals (STD-I18N-002, STD-I18N-003). `locale` is the
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

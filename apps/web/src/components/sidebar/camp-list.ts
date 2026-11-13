/** How many camps show under the open hob before Show more. */
const CAMPS_SHOWN = 5;

/** What the sidebar shows of a hob's camps: the rows, and what Show more would add. */
export interface CampList<T> {
  readonly shown: ReadonlyArray<T>;
  /** How many camps Show more would add; 0 when every camp shows. */
  readonly hidden: number;
  /** Whether a camp Show more would add has messages you have not read. */
  readonly hiddenUnread: boolean;
}

/**
 * The first few camps in their order (pinned first), and the open camp wherever it falls, so the
 * row for the page you are on never hides. `unread` holds the threads you have not read.
 */
export const campList = <T extends { readonly id: string }>(
  camps: ReadonlyArray<T>,
  openId: string | undefined,
  unread: ReadonlySet<string>,
  limit: number = CAMPS_SHOWN,
): CampList<T> => {
  if (camps.length <= limit) return { shown: camps, hidden: 0, hiddenUnread: false };
  const shown = camps.filter((camp, index) => index < limit || camp.id === openId);
  const left = camps.filter((camp) => !shown.includes(camp));
  return { shown, hidden: left.length, hiddenUnread: left.some((camp) => unread.has(camp.id)) };
};

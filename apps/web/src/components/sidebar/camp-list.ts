/** How many camps show under the open hob before Show more. */
const CAMPS_SHOWN = 5;

/** What the sidebar shows of a hob's camps: the rows, and the ones Show more would add. */
export interface CampList<T> {
  readonly shown: ReadonlyArray<T>;
  /** The camps Show more would add; none when every camp shows. */
  readonly hidden: ReadonlyArray<T>;
}

/**
 * The first few camps in their order (pinned first), and the open camp wherever it falls, so the
 * row for the page you are on never hides.
 */
export const campList = <T extends { readonly id: string }>(
  camps: ReadonlyArray<T>,
  openId: string | undefined,
  limit: number = CAMPS_SHOWN,
): CampList<T> => {
  if (camps.length <= limit) return { shown: camps, hidden: [] };
  const shown = camps.filter((camp, index) => index < limit || camp.id === openId);
  return { shown, hidden: camps.filter((camp) => !shown.includes(camp)) };
};

/**
 * What the folded camps hold for you, for Show more to tell: the replies you have not read and how
 * many of them mention you, so a mention in a hidden camp is never lost.
 */
export const foldedNews = (
  hidden: ReadonlyArray<{ readonly unread: number; readonly place: { readonly mentions: number } }>,
): { readonly unread: number; readonly mentions: number } => ({
  unread: hidden.reduce((sum, camp) => sum + camp.unread, 0),
  mentions: hidden.reduce((sum, camp) => sum + camp.place.mentions, 0),
});

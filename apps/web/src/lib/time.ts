const DAY = 24 * 60 * 60 * 1000;

/** Short, friendly timestamps: "Now", "12 min", "3:40 PM", "Yesterday", "Oct 24". */
export const formatWhen = (iso: string, now: Date = new Date()): string => {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();
  if (diff < 60_000) return "Now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (then.getTime() >= startOfToday) return then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (then.getTime() >= startOfToday - DAY) return "Yesterday";
  return then.toLocaleDateString([], { month: "short", day: "numeric" });
};

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Greeting for the Home scene by local hour. */
export const greeting = (date: Date = new Date()): string => {
  const hour = date.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
};

/** A calendar day: "Oct 12", with the year when it is not this year. */
export const formatDay = (iso: string, now: Date = new Date()): string => {
  const then = new Date(iso);
  return then.toLocaleDateString(
    [],
    then.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
};

/** When a provider's allowance refills: "It refills at 4:00 PM, in 52 minutes." */
export const refillText = (resetsAt: string | null, now: Date = new Date()): string => {
  if (resetsAt === null) return "It refills later; the provider did not say when.";
  const minutes = Math.ceil((new Date(resetsAt).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "It should have refilled by now.";
  const wait =
    minutes < 60
      ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
      : `${Math.round(minutes / 60)} ${Math.round(minutes / 60) === 1 ? "hour" : "hours"}`;
  return `It refills at ${formatTime(resetsAt)}, in ${wait}.`;
};

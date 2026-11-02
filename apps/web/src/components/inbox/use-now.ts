import { useEffect, useState } from "react";

/**
 * The time now, updated every half minute by default, so "expires in" counts down while the page is
 * open. A running command's clock passes a second. `every` of null stops the updates.
 */
export const useNow = (every: number | null = 30_000): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (every === null) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
};

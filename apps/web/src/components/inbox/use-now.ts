import { useEffect, useState } from "react";

/** The time now, updated every half minute, so "expires in" counts down while the page is open. */
export const useNow = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

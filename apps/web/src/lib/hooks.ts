import { useEffect, useState } from "react";

/** Re-renders every `intervalMs`, e.g. so emotes fade out and tiles re-sort on time. */
export function useNow(intervalMs: number, clock: () => number = Date.now) {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, clock]);
  return now;
}

import { useEffect, useState } from 'react';

/** A shared clock for relative timestamps. Kept out of the app's render path
 *  so a one-second tick does not re-render the run detail. */
export default function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}

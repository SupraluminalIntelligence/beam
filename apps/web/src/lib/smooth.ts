import { useEffect, useRef, useState } from "react";

/**
 * Streamed text reaches the client in chunks (one Convex patch every ~60-130ms). While a message is live,
 * reveal each chunk character by character over roughly the gap until the next chunk, so it reads like
 * token-level streaming. Snaps to the full text the moment the message stops being live.
 */
export function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(target);
  const r = useRef({ shown: target, lastAt: 0, interval: 90, raf: 0 });
  useEffect(() => {
    const st = r.current;
    cancelAnimationFrame(st.raf);
    if (!live || !target.startsWith(st.shown)) { st.shown = target; setShown(target); return; }
    if (target === st.shown) return;
    const now = performance.now();
    if (st.lastAt) st.interval = Math.min(400, Math.max(40, st.interval * 0.6 + (now - st.lastAt) * 0.4));
    st.lastAt = now;
    const from = st.shown.length, total = target.length - from, dur = Math.max(30, st.interval * 1.1);
    const tick = () => {
      const p = Math.min(1, (performance.now() - now) / dur);
      st.shown = target.slice(0, from + Math.ceil(total * p));
      setShown(st.shown);
      if (p < 1) st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(st.raf);
  }, [target, live]);
  return live ? shown : target;
}

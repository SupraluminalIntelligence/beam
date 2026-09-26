import { useLayoutEffect, useRef } from "react";

/** Follow real content growth only while the reader is at the bottom. */
export function useFollowScroll(chatId: string, ready: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const pause = useRef(() => {});
  const resume = useRef(() => {});
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewport.current, body = content.current;
    if (!el || !body || !ready) return;
    let active = true, following = true, frame = 0, previous = 0, lastTime = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const bottom = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const cancel = () => { cancelAnimationFrame(frame); frame = 0; lastTime = 0; };
    const stop = () => { following = false; cancel(); };
    pause.current = stop;
    const step = (now: number) => {
      frame = 0;
      if (!following) return;
      const target = bottom(), distance = target - el.scrollTop;
      const dt = lastTime ? Math.min(64, now - lastTime) : 16;
      lastTime = now;
      el.scrollTop = reducedMotion.matches || Math.abs(distance) <= 2 ? target : el.scrollTop + distance * (1 - Math.exp(-dt / 65));
      previous = el.scrollTop;
      if (Math.abs(target - el.scrollTop) > 2) frame = requestAnimationFrame(step);
      else { el.scrollTop = target; previous = el.scrollTop; lastTime = 0; }
    };
    const follow = () => { if (following && !frame) frame = requestAnimationFrame(step); };
    resume.current = () => { if (active) { following = true; previous = el.scrollTop; follow(); } };
    const scroll = () => {
      const top = el.scrollTop;
      if (top < previous - 1) stop();
      else if (bottom() - top <= 24) { following = true; follow(); }
      previous = top;
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) stop(); };
    let touchY = 0;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) stop();
      touchY = y;
    };
    const key = (event: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stop(); };
    el.scrollTop = bottom(); previous = el.scrollTop;
    const observer = new ResizeObserver(follow);
    observer.observe(body); observer.observe(el);
    el.addEventListener("scroll", scroll, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("keydown", key);
    return () => {
      active = false; resume.current = () => {}; pause.current = () => {};
      cancel(); observer.disconnect();
      el.removeEventListener("scroll", scroll); el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touchStart); el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("keydown", key);
    };
  }, [chatId, ready]);
  return { viewport, content, pause, resume };
}

import { useLayoutEffect, useRef } from "react";

function resize(input: HTMLTextAreaElement) {
  const scrollTop = input.scrollTop;
  input.style.height = "auto";
  input.style.overflowY = "hidden";
  const limit = Number.parseFloat(getComputedStyle(input).maxHeight) || Infinity;
  const height = input.scrollHeight;
  input.style.height = `${Math.min(height, limit)}px`;
  input.style.overflowY = height > limit ? "auto" : "hidden";
  input.scrollTop = scrollTop;
}

/** Resize after every value update, including paste, mentions, and restored drafts. */
export function useAutoSizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (ref.current) resize(ref.current); }, [value]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize(input);
    });
    observer.observe(input);
    const onFontsLoaded = () => resize(input);
    document.fonts.addEventListener("loadingdone", onFontsLoaded);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", onFontsLoaded); };
  }, []);
  return ref;
}

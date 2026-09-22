import { useEffect, useRef, useState, type DragEvent } from "react";

export function useFileDrop(attach: (files: File[]) => void | Promise<void>) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reset = () => { depth.current = 0; setDragging(false); };
  useEffect(() => {
    const cancel = () => { depth.current = 0; setDragging(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("dragend", cancel);
    window.addEventListener("drop", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("drop", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  return { dragging, handlers: {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth.current += 1; setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      reset();
      if (!hasFiles(event)) return;
      event.preventDefault(); event.stopPropagation();
      const files = Array.from(event.dataTransfer.files);
      if (files.length) void attach(files);
    },
  } };
}

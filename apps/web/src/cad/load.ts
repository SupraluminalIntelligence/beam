import { MAX_CAD_BYTES, checkCadFile, type CadModel } from "./model";

/** Bound downloads even when Content-Length is missing or inaccurate. */
export async function fetchCad(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok || !response.body) throw new Error("Could not download this model. Check your connection and try again.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_CAD_BYTES) throw new Error("This model exceeds the 20 MB preview limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Disposable worker: cancellation/timeout also releases the CAD kernel's WASM heap. */
export function importCad(name: string, bytes: ArrayBuffer, signal: AbortSignal, sample = false): Promise<CadModel> {
  if (!sample) checkCadFile(name, bytes.byteLength);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
    const worker = new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Model conversion took longer than 90 seconds. Try a simpler model or a coarser STL export.")); }, 90_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { cleanup(); reject(new Error("The model importer stopped unexpectedly. Try a smaller model or reload the viewer.")); };
    worker.onmessage = (event: MessageEvent<{ model?: CadModel; error?: string }>) => {
      cleanup(); if (event.data.model) resolve(event.data.model); else reject(new Error(event.data.error ?? "Model import failed."));
    };
    worker.postMessage({ name, bytes, sample }, [bytes]);
  });
}

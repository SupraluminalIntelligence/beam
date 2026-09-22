import { afterEach, expect, it, vi } from "vitest";
import { fetchCad, importCad } from "./load";
import { MAX_CAD_BYTES } from "./model";
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it("bounds streamed downloads without depending on a Content-Length header", async () => {
  const cancel=vi.fn(); let sent=false;
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(MAX_CAD_BYTES+1));}},cancel}))));
  await expect(fetchCad("https://storage.example/model.stl",new AbortController().signal)).rejects.toThrow("20 MB");
  expect(cancel).toHaveBeenCalled();
});
it("downloads model bytes without cookies", async () => {
  const fetch=vi.fn(async()=>new Response(new Uint8Array([1,2,3])));vi.stubGlobal("fetch",fetch);
  const signal=new AbortController().signal;
  expect([...new Uint8Array(await fetchCad("https://storage.example/model.stl",signal))]).toEqual([1,2,3]);
  expect(fetch).toHaveBeenCalledWith("https://storage.example/model.stl",{signal,credentials:"omit"});
});
it("terminates the worker when an import is cancelled or times out", async () => {
  vi.useFakeTimers();const terminate=vi.fn(),postMessage=vi.fn();
  vi.stubGlobal("Worker",class { terminate=terminate;postMessage=postMessage; });
  const controller=new AbortController();
  const cancelled=importCad("part.stl",new ArrayBuffer(84),controller.signal);
  const cancellation=expect(cancelled).rejects.toMatchObject({name:"AbortError"});controller.abort();await cancellation;
  expect(terminate).toHaveBeenCalledTimes(1);
  const timed=importCad("part.stl",new ArrayBuffer(84),new AbortController().signal);
  const timeout=expect(timed).rejects.toThrow("90 seconds");await vi.advanceTimersByTimeAsync(90_000);await timeout;
  expect(terminate).toHaveBeenCalledTimes(2);
});

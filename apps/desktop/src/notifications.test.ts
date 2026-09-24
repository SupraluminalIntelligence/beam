import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ supported: true, banners: [] as any[] }));
vi.mock("electron", () => ({ Notification: class extends EventEmitter {
  static isSupported() { return native.supported; }
  constructor(public options: any) { super(); native.banners.push(this); }
  show = vi.fn(); close = vi.fn();
} }));
import { showNotification } from "./notifications";
const notice = (id: string, silent = false) => ({ id, title: "Noah mentioned you", body: "Design: @you take a look", silent });
afterEach(() => { vi.useRealTimers(); native.supported = true; });
it("requests sound, waits for the native show event, and retains click navigation", async () => {
  const clicked = vi.fn(), result = showNotification(notice("shown"), clicked), banner = native.banners.at(-1);
  expect(banner.options.silent).toBe(false);
  if (process.platform === "darwin") expect(banner.options.sound).toBe("default");
  expect(showNotification(notice("shown"), clicked)).toBe(result);
  banner.emit("show"); expect(await result).toBe(true);
  banner.emit("click"); expect(clicked).toHaveBeenCalledOnce(); banner.emit("close");
});
it("respects silent mode and allows retry after native failure", async () => {
  const first = showNotification(notice("failed", true), () => {}), banner = native.banners.at(-1);
  expect(banner.options).toMatchObject({ silent: true }); expect(banner.options.sound).toBeUndefined();
  banner.emit("failed", {}, "permission denied"); expect(await first).toBe(false);
  const second = showNotification(notice("failed", true), () => {});
  expect(native.banners.at(-1)).not.toBe(banner);
  native.banners.at(-1).emit("show"); expect(await second).toBe(true); native.banners.at(-1).emit("close");
});
it("returns failure on timeout or unsupported platforms", async () => {
  vi.useFakeTimers(); const pending = showNotification(notice("timeout"), () => {});
  vi.advanceTimersByTime(10_000); expect(await pending).toBe(false);
  expect(native.banners.at(-1).close).toHaveBeenCalledOnce();
  native.supported = false; expect(await showNotification(notice("unsupported"), () => {})).toBe(false);
});

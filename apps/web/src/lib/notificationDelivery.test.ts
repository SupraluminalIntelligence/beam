import { afterEach, expect, it, vi } from "vitest";
import { NotificationDelivery } from "./notificationDelivery";
afterEach(() => vi.useRealTimers());
const transport = () => ({ reserve: vi.fn(async (_token: string) => true), show: vi.fn(async () => true), finish: vi.fn(async (_token: string, _accepted: boolean) => {}) });
it("waits for native acceptance before acknowledging, and prevents concurrent duplicates", async () => {
  const queue = new NotificationDelivery(), io = transport();
  let resolve!: (ok: boolean) => void;
  io.show.mockImplementation(() => new Promise(r => { resolve = r; }));
  const first = queue.deliver("one", io);
  await vi.waitFor(() => expect(io.show).toHaveBeenCalledOnce());
  await queue.deliver("one", io);
  expect(io.reserve).toHaveBeenCalledOnce(); expect(io.finish).not.toHaveBeenCalled();
  resolve(true); await first;
  expect(io.finish).toHaveBeenCalledWith(io.reserve.mock.calls[0]![0], true);
});
it("releases failed banners for bounded retry and preserves unread history", async () => {
  vi.useFakeTimers(); const queue = new NotificationDelivery(), io = transport();
  io.show.mockResolvedValue(false);
  await queue.deliver("one", io);
  expect(io.finish).toHaveBeenLastCalledWith(expect.any(String), false);
  await queue.deliver("one", io); expect(io.show).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 4; n++) { vi.advanceTimersByTime(30_000); await queue.deliver("one", io); }
  expect(io.show).toHaveBeenCalledTimes(3);
});
it("does not ring again when delivery succeeded but acknowledgment was interrupted", async () => {
  vi.useFakeTimers(); const queue = new NotificationDelivery(), io = transport();
  io.finish.mockRejectedValueOnce(new Error("offline"));
  await queue.deliver("one", io);
  vi.advanceTimersByTime(30_000); await queue.deliver("one", io);
  expect(io.show).toHaveBeenCalledOnce(); expect(io.finish).toHaveBeenCalledTimes(2);
  expect(io.finish).toHaveBeenLastCalledWith(expect.any(String), true);
});
it("does not deliver when another device has reserved the alert", async () => {
  const queue = new NotificationDelivery(), io = transport(); io.reserve.mockResolvedValue(false);
  await queue.deliver("one", io);
  expect(io.show).not.toHaveBeenCalled(); expect(io.finish).not.toHaveBeenCalled();
});
it("releases a reservation when the native bridge throws", async () => {
  const queue = new NotificationDelivery(), io = transport(); io.show.mockRejectedValueOnce(new Error("IPC disconnected"));
  await queue.deliver("one", io);
  expect(io.finish).toHaveBeenCalledWith(expect.any(String), false);
});

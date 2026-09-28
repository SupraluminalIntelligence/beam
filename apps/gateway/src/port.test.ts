import { expect, it, vi } from "vitest";
import type { ModalClient } from "modal";
import { modalPort } from "./port.ts";

it("retries the Modal app lookup after a failure instead of caching it", async () => {
  const sandbox = { sandboxId: "sb-1" };
  const client = {
    apps: { fromName: vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue({ appId: "ap-1" }) },
    images: { fromRegistry: vi.fn(() => ({})) },
    sandboxes: { create: vi.fn(async () => sandbox) },
  };
  const port = modalPort("beam-test", client as unknown as ModalClient);
  const spec = { name: "beam-job-1", image: "img", command: ["bash"], env: {}, cpu: 4, cpuLimit: 4, memoryMiB: 1024, memoryLimitMiB: 1024, timeoutMs: 1000, tags: {} };
  await expect(port.create(spec)).rejects.toThrow("503");
  expect((await port.create(spec)).sandbox.id).toBe("sb-1");
  expect(client.apps.fromName).toHaveBeenCalledTimes(2);
});

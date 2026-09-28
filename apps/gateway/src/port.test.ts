import { expect, it, vi } from "vitest";
import { InvalidError, type ModalClient } from "modal";
import { modalPort, SandboxRejected } from "./port.ts";

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

it("tells an image Modal cannot build or an invalid request apart from a failure that may pass", async () => {
  const client = {
    apps: { fromName: vi.fn(async () => ({ appId: "ap-1" })) },
    images: { fromRegistry: vi.fn(() => ({})) },
    sandboxes: { create: vi.fn()
      .mockRejectedValueOnce(new Error("Image build for im-1 failed with the exception:\nmanifest unknown"))
      .mockRejectedValueOnce(new InvalidError("bad gpu"))
      .mockRejectedValueOnce(Object.assign(new Error("unavailable"), { name: "ClientError", code: 14 })) },
  };
  const port = modalPort("beam-test", client as unknown as ModalClient);
  const spec = { name: "beam-job-1", image: "img", command: ["bash"], env: {}, cpu: 4, cpuLimit: 4, memoryMiB: 1024, memoryLimitMiB: 1024, timeoutMs: 1000, tags: {} };
  await expect(port.create(spec)).rejects.toBeInstanceOf(SandboxRejected);
  await expect(port.create(spec)).rejects.toBeInstanceOf(SandboxRejected);
  const outage = await port.create(spec).catch(e => e);
  expect(outage).not.toBeInstanceOf(SandboxRejected);
});

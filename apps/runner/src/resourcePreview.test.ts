import { expect, it, vi } from "vitest";
vi.mock("./resources.ts", () => ({ requestResource: vi.fn(async () => JSON.stringify({ status: 200, contentType: "text/html", body: Buffer.from("<p>Shared site</p>").toString("base64"), more: false })) }));
import { requestResource } from "./resources";
import { startResourcePreview } from "./resourcePreview";

it("requires a secret bootstrap and private cookie before relaying a workspace preview", async () => {
  const client = { close: vi.fn(async () => {}) };
  const preview = await startResourcePreview(client as any, "beam-local-token", "chat" as any, "resource" as any);
  const origin = new URL(preview.url).origin;
  try {
    expect((await fetch(origin)).status).toBe(403);
    const bootstrap = await fetch(preview.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303); expect(bootstrap.headers.get("location")).toBe("/");
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`${origin}/page?name=beam`, { headers: { cookie } });
    expect(await page.text()).toBe("<p>Shared site</p>");
    expect(vi.mocked(requestResource).mock.calls.at(-1)?.[4]).toMatchObject({ path: "/page?name=beam", kind: "http" });
    expect((await fetch(origin, { method: "POST", headers: { cookie } })).status).toBe(405);
  } finally { await new Promise<void>(resolve => preview.server.close(() => resolve())); }
});

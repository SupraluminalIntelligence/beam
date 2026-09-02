import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

declare const process: { env: Record<string, string | undefined> };

const http = httpRouter();
auth.addHttpRoutes(http);

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));
http.route({ path: "/runner/device/start", method: "OPTIONS", handler: preflight });
http.route({ path: "/runner/device/poll", method: "OPTIONS", handler: preflight });

/** Runner device-code login. Unauthenticated by design: the code is worthless until a signed-in person approves it. */
http.route({
  path: "/runner/device/start", method: "POST",
  handler: httpAction(async (ctx, req) => {
    const b = (await req.json().catch(() => ({}))) as { name?: string; hostname?: string; kind?: string };
    const kind = b.kind === "desktop" ? "desktop" : "runner";
    const r = await ctx.runMutation(internal.runnerAuth.start, { name: String(b.name ?? "runner").slice(0, 60), hostname: String(b.hostname ?? "").slice(0, 60), kind });
    const site = process.env["SITE_URL"] ?? "";
    return json({ ...r, verifyUrl: `${site}/?${kind === "desktop" ? "approve" : "pair"}=${r.userCode}` });
  }),
});
http.route({
  path: "/runner/device/poll", method: "POST",
  handler: httpAction(async (ctx, req) => {
    const b = (await req.json().catch(() => ({}))) as { deviceCode?: string };
    if (!b.deviceCode) return json({ status: "unknown" }, 400);
    return json(await ctx.runMutation(internal.runnerAuth.poll, { deviceCode: b.deviceCode }));
  }),
});

export default http;

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ConvexClient } from "convex/browser";
import type { Id } from "../../../convex/_generated/dataModel";
import { requestResource } from "./resources.ts";

/** Authenticated workspace relay exposed only on this viewer's loopback interface. No public tunnel. */
export async function startResourcePreview(client: ConvexClient, token: string, chatId: Id<"chats">, resourceId: Id<"workspaceResources">) {
  const secret = randomBytes(32).toString("hex"); const cookieName = `beam_preview_${randomBytes(8).toString("hex")}`;
  let lastAccess = Date.now();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const supplied = url.searchParams.get("beam_preview") ?? req.headers.cookie?.split(";").map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? "";
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) { res.writeHead(403).end("Open this preview from Beam."); return; }
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { res.writeHead(403).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end("This shared preview supports viewing only."); return; }
    lastAccess = Date.now();
    if (url.searchParams.has("beam_preview")) {
      url.searchParams.delete("beam_preview");
      res.writeHead(303, { Location: url.pathname + url.search, "Set-Cookie": `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }).end(); return;
    }
    try {
      let offset = 0; let first = true;
      while (!res.destroyed) {
        const result = JSON.parse(await requestResource(client, token, { chatId }, resourceId, { kind: "http", path: url.pathname + url.search, method: req.method as "GET" | "HEAD", offset })) as { status: number; contentType: string; body: string; more: boolean; location?: string };
        if (first) { res.writeHead(result.status, { "Content-Type": result.contentType, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(result.location ? { Location: result.location } : {}) }); first = false; }
        const body = Buffer.from(result.body, "base64"); res.write(body); offset += body.length;
        if (!result.more || req.method === "HEAD") break;
        if (offset > 16_000_000) throw new Error("Preview asset exceeds 16 MB");
      }
      res.end();
    } catch (e) { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }).end((e as Error).message); else res.destroy(); }
  });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const idle = setInterval(() => { if (Date.now() - lastAccess > 30 * 60_000) server.close(); }, 60_000);
  server.on("close", () => { clearInterval(idle); void client.close(); });
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/?beam_preview=${secret}` };
}

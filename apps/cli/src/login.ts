import { hostname } from "node:os";
import { convexUrl, readConfig, siteUrl, writeConfig } from "./config.ts";

/**
 * Device-code login, the same flow a runner uses. Nothing is typed here: the person approves the code in
 * Beam, where they see this layer's name and what it asks to do.
 */
export async function login(opts: { name: string; scopes: string[]; log: (line: string) => void }): Promise<{ login: string }> {
  const cloud = convexUrl(await readConfig());
  const site = siteUrl(cloud);
  const res = await fetch(`${site}/layer/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: opts.name, hostname: hostname(), scopes: opts.scopes }) });
  const start = (await res.json().catch(() => ({}))) as { deviceCode?: string; userCode?: string; verifyUrl?: string; error?: string };
  if (!res.ok || !start.deviceCode) throw new Error(start.error ?? `could not start sign-in (${res.status})`);
  opts.log(`\nApprove "${opts.name}" in Beam:\n\n    ${start.userCode}\n\nOpen ${start.verifyUrl}\nor Settings → Connected apps. It will be able to: ${opts.scopes.join(", ")}.\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(`${site}/layer/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: start.deviceCode }) });
    const r = (await poll.json()) as { status: string; token?: string; githubLogin?: string; scopes?: string[] };
    if (r.status === "approved" && r.token && r.githubLogin) {
      await writeConfig({ convexUrl: cloud, token: r.token, login: r.githubLogin, name: opts.name, scopes: r.scopes ?? opts.scopes });
      return { login: r.githubLogin };
    }
    if (r.status === "denied") throw new Error("the request was declined in Beam");
    if (r.status !== "pending") throw new Error("the code expired; run `beam login` again");
  }
}

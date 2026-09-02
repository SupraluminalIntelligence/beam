import { hostname } from "node:os";
import { convexUrl, defaultName, siteUrl, writeConfig } from "./config.ts";

/**
 * Device-code login. The runner never opens a browser. It prints a code; a signed-in Beam
 * app approves it (automatically when the app launched this runner, by hand otherwise).
 */
export async function login(opts: { name?: string; fromApp?: boolean } = {}): Promise<{ token: string; githubLogin: string; name: string }> {
  const cloud = convexUrl();
  const site = siteUrl(cloud);
  const name = opts.name ?? defaultName();
  const start = await fetch(`${site}/runner/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, hostname: hostname() }) });
  if (!start.ok) throw new Error(`device start failed: ${start.status}`);
  const { deviceCode, userCode, verifyUrl } = (await start.json()) as { deviceCode: string; userCode: string; verifyUrl: string };
  if (opts.fromApp) console.log(`BEAM_PAIR ${userCode}`);
  else console.log(`\nApprove this runner in Beam:\n\n    ${userCode}\n\nSettings → Connected harnesses → Approve a runner, or open ${verifyUrl}\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(`${site}/runner/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode }) });
    const r = (await res.json()) as { status: string; token?: string; githubLogin?: string };
    if (r.status === "approved" && r.token && r.githubLogin) {
      await writeConfig({ convexUrl: cloud, token: r.token, githubLogin: r.githubLogin, name });
      console.log(`Signed in as ${r.githubLogin}. Runner "${name}" registered.`);
      return { token: r.token, githubLogin: r.githubLogin, name };
    }
    if (r.status === "expired" || r.status === "unknown") throw new Error("device code expired, run login again");
  }
}

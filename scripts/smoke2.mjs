// Two people, one chat: guest A creates a workspace and chat, invites guest B by login, B sees the chat,
// both send messages, presence avatars appear on the chat row for both, reactions cross over.
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const mk = async () => { const c = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: "dark" }); const p = await c.newPage(); return p; };
const A = await mk(), B = await mk();
const errs = [];
for (const p of [A, B]) p.on("pageerror", (e) => errs.push(e.message));
const login = async (p) => { await p.goto("http://localhost:5173/", { waitUntil: "networkidle" }); await p.getByRole("button", { name: "Continue as a guest" }).click(); };
try {
  await login(A); await login(B);
  await A.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 20000 });
  await A.getByPlaceholder("acme").fill("acme"); await A.getByPlaceholder("owner/name (optional)").fill("acme/platform");
  await A.getByRole("button", { name: "Create" }).click();
  await A.getByText("+ New chat").waitFor({ timeout: 20000 });
  await B.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 20000 });
  // B's login from its own account footer
  const bLogin = (await B.locator(".signin .box").innerText()).match(/guest-[a-z0-9]+/)?.[0] ?? null;
  // A opens a team chat and invites B
  await A.getByText("+ New chat").click(); await A.getByText("Team chat").first().click();
  await A.getByPlaceholder(/Message Untitled/).waitFor({ timeout: 20000 });
  await A.getByPlaceholder(/Message Untitled/).fill("noah, gateway or per-service jwt?"); await A.keyboard.press("Enter");
  await A.locator(".msg .tx", { hasText: "gateway or per-service" }).waitFor();
  // find B's login: B has no workspace yet so there is no footer; read it from B's Gate via a second path: A invites using a placeholder, so instead sign B's login from localStorage-less API: use the me query text by creating a throwaway workspace for B
  await B.getByPlaceholder("acme").fill("scratch"); await B.getByRole("button", { name: "Create" }).click();
  await B.getByText("+ New chat").waitFor({ timeout: 20000 });
  const bName = (await B.locator(".acct .nm").innerText()).trim();
  await A.locator(".scopebtn").click(); await A.getByText("Invite someone new").click();
  await A.getByPlaceholder("octocat").fill(bName); await A.locator(".modal .btn").filter({ hasText: /^Invite$/ }).click();
  await A.getByText(/Invited/).waitFor({ timeout: 10000 });
  // B: switch to acme workspace, open the chat
  await B.locator(".ws-item", { hasText: "acme" }).waitFor({ timeout: 20000 });
  await B.locator(".ws-item", { hasText: "acme" }).click();
  await B.locator(".th-item").first().click();
  await B.locator(".msg .tx", { hasText: "gateway or per-service" }).waitFor({ timeout: 20000 });
  await B.getByPlaceholder(/Message/).fill("gateway. @claude take the plan above"); await B.keyboard.press("Enter");
  await A.locator(".msg .tx", { hasText: "take the plan above" }).waitFor({ timeout: 20000 });
  // presence: A should see two avatars on the chat row
  await A.waitForTimeout(1500);
  const hereCount = await A.locator(".th-item.on .here .av").count();
  await A.locator(".msg").last().hover(); await A.locator(".msg").last().locator(".rbar button").nth(1).click();
  await B.locator(".reacts .rc").waitFor({ timeout: 20000 });
  await A.screenshot({ path: "/tmp/beam-shots/two-A.png" }); await B.screenshot({ path: "/tmp/beam-shots/two-B.png" });
  const kinds = await B.locator(".msg").evaluateAll((els) => els.map((e) => e.className));
  console.log(JSON.stringify({ ok: true, bName, hereCount, kinds, errs }));
} catch (e) { await A.screenshot({ path: "/tmp/beam-shots/two-err-A.png" }); await B.screenshot({ path: "/tmp/beam-shots/two-err-B.png" }); console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 400), errs })); }
finally { await browser.close(); }

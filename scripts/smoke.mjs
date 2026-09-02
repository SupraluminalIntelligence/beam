// Drives the web app in a real Chrome: guest sign-in, first workspace, a chat, a message, a reaction.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
mkdirSync("/tmp/beam-shots", { recursive: true });
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: "dark" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
const shot = (n) => page.screenshot({ path: `/tmp/beam-shots/${n}.png` });
try {
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await shot("1-signin");
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByRole("heading", { name: "Your first workspace" }).waitFor({ timeout: 20000 });
  await shot("2-first-workspace");
  await page.getByPlaceholder("acme").fill("acme");
  await page.getByPlaceholder("owner/name (optional)").fill("acme/platform");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByText("+ New chat").waitFor({ timeout: 20000 });
  await shot("3-shell-empty");
  await page.getByText("+ New chat").click();
  await page.getByText("Team chat", { exact: false }).first().click();
  await page.getByPlaceholder(/Message Untitled/).waitFor({ timeout: 20000 });
  await shot("4-new-chat");
  const ta = page.getByPlaceholder(/Message Untitled/);
  await ta.fill("session validation belongs in the gateway, every service re-checking the JWT is what bit us on friday");
  await ta.press("Enter");
  await page.getByText("bit us on friday").waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const title = await page.locator(".thead .t").innerText();
  await page.getByPlaceholder(/Message/).fill("@cl");
  await page.waitForTimeout(300);
  await shot("5-mention");
  await page.keyboard.press("Escape");
  await page.getByPlaceholder(/Message/).fill("");
  await page.locator(".msg").first().hover();
  await page.locator(".rbar button").first().click();
  await page.locator(".reacts .rc").waitFor({ timeout: 10000 });
  await shot("6-reaction");
  await page.locator(".scopebtn").click();
  await page.waitForTimeout(300);
  await shot("7-scope");
  console.log(JSON.stringify({ ok: true, title, errors }));
} catch (e) {
  await shot("err");
  console.log(JSON.stringify({ ok: false, error: String(e), errors }));
} finally { await browser.close(); }

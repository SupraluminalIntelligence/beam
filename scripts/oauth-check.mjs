import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const p = await b.newPage();
await p.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await p.getByRole("button", { name: "Continue with GitHub" }).click();
await p.waitForURL(/github\.com/, { timeout: 20000 });
const u = new URL(p.url());
console.log(JSON.stringify({ host: u.host, path: u.pathname, client_id: u.searchParams.get("client_id"), redirect_uri: u.searchParams.get("redirect_uri"), scope: u.searchParams.get("scope") }));
await b.close();

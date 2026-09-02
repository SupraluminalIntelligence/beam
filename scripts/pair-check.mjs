import { chromium } from "playwright-core";
const code = process.argv[2];
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const p = await b.newPage({ viewport: { width: 1380, height: 860 }, colorScheme: "dark" });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
try {
  await p.goto("http://localhost:5173/?pair=" + code, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Continue as a guest" }).click();
  await p.getByText("+ New chat").waitFor({ timeout: 20000 });
  await p.keyboard.press("Meta+,");
  await p.getByText("Approve a runner").waitFor({ timeout: 10000 });
  const inp = p.locator('input[placeholder="XXXX-XXXX"]');
  await inp.fill(code);
  await p.getByText(/is waiting/).waitFor({ timeout: 10000 });
  await p.getByRole("button", { name: "Approve" }).click();
  await p.getByText(/approved/).first().waitFor({ timeout: 10000 });
  await p.locator(".hrow.head").first().waitFor({ timeout: 30000 });
  await p.locator(".hrow .st.authenticated").first().waitFor({ timeout: 30000 });
  await p.screenshot({ path: "/tmp/beam-shots/harnesses.png" });
  const rows = await p.locator(".hrow").allInnerTexts();
  console.log(JSON.stringify({ ok: true, rows: rows.map((r) => r.replace(/\s+/g, " ").trim()), errs }));
} catch (e) { await p.screenshot({ path: "/tmp/beam-shots/pair-err.png" }); console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300), errs })); }
finally { await b.close(); }

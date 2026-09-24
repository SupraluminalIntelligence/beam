// A detached, credential-free supervisor. Its receipts survive the Beam connector.
import { readFile, writeFile, rename, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.argv[2];
const spec = JSON.parse(await readFile(join(root, "spec.json"), "utf8"));
const atomic = async (name, value) => {
  const temp = join(root, `${name}.tmp`);
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, join(root, name));
};
let log = "", cancelled = false, timedOut = false, child, finished = false, killing;
let receiptWrites = Promise.resolve();
const receipt = (name, value) => receiptWrites = receiptWrites.then(() => atomic(name, value));
const killTree = (signal) => {
  if (!child?.pid) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch {}
};
const stop = () => {
  if (killing) return;
  killTree("SIGTERM");
  killing = setTimeout(() => killTree("SIGKILL"), 1500);
};
const append = chunk => { log = (log + chunk.toString()).slice(-16000); };
await mkdir(join(root, "work"), { recursive: true });
try {
  await access(join(root, "cancel")); cancelled = true;
} catch {}
await receipt("status.json", { pid: process.pid, heartbeatAt: Date.now(), log });
const ticker = setInterval(() => {
  if (finished) return;
  void receipt("status.json", { pid: process.pid, heartbeatAt: Date.now(), log }).catch(() => { cancelled = true; stop(); });
  void access(join(root, "cancel")).then(() => { cancelled = true; stop(); }, () => {});
}, 500);
let exitCode = null, error = null;
const timeout = setTimeout(() => { timedOut = true; stop(); }, spec.timeoutSeconds * 1000);
try {
  if (!cancelled) {
    child = spawn(spec.executable, spec.args, { cwd: join(root, "work"), shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", append); child.stderr.on("data", append);
    exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  }
} catch (e) { error = e.message; }
finally {
  finished = true; clearInterval(ticker); clearTimeout(timeout); clearTimeout(killing);
  // Jobs must not leave descendants running after their main process exits.
  killTree("SIGKILL");
  if (/^beam-foam-[a-f0-9]{20}$/.test(spec.dockerContainer ?? "")) {
    await new Promise(resolve => {
      const cleanup = spawn("docker", ["rm", "-f", spec.dockerContainer], { stdio: "ignore" });
      const deadline = setTimeout(() => { cleanup.kill("SIGKILL"); resolve(); }, 10000);
      const done = () => { clearTimeout(deadline); resolve(); };
      cleanup.once("error", done); cleanup.once("close", done);
    });
  }
  error = cancelled ? "Cancelled" : timedOut ? "Runtime limit exceeded" : error ?? (exitCode === 0 ? null : `Process exited with code ${exitCode}`);
  await receipt("result.json", { state: cancelled ? "cancelled" : error ? "failed" : "succeeded", log, error, exitCode });
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// `start` and `smoke` run under Node's type stripping, which rejects TypeScript that needs transforming
// (parameter properties, enums). Vitest compiles everything, so check the real loader here.
it("loads under Node's type stripping", async () => {
  const load = "await Promise.all(['./src/modal.ts', './src/watch.ts', './src/port.ts', './src/supervisor.ts'].map(m => import(m)))";
  const { stderr } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", load], { cwd: new URL("..", import.meta.url) });
  expect(stderr).toBe("");
}, 30_000);

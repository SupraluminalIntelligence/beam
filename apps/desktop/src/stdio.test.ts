import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ignoreBrokenPipeErrors } from "./stdio";

it.each(["stdout", "stderr"] as const)("continues logging after the %s reader closes", async (output) => {
  const module = pathToFileURL(resolve("src/stdio.ts")).href;
  const code = `
    import { Console } from 'node:console';
    import { ignoreBrokenPipeErrors } from ${JSON.stringify(module)};
    ignoreBrokenPipeErrors(process.stdout, process.stderr);
    // Exercise consoles that propagate write errors, as well as direct stdio writes.
    const log = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    process.send('ready');
    process.on('message', () => {
      log.${output === "stdout" ? "log" : "error"}('runner line');
      setImmediate(() => {
        log.${output === "stdout" ? "log" : "error"}('later runner line');
        log.${output === "stdout" ? "error" : "log"}('healthy output');
        setImmediate(() => { process.send('continued'); process.disconnect(); });
      });
    });
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: unknown[] = [];
  let healthyOutput = "";
  let stderr = "";
  child.on("message", message => messages.push(message));
  child.stderr!.on("data", data => stderr += data);
  child[output === "stdout" ? "stderr" : "stdout"]!.on("data", data => healthyOutput += data);
  const exited = once(child, "exit");
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(([code, signal]) => { throw new Error(`Worker exited before ready (${code ?? signal}): ${stderr}`); }),
    ]);
    expect(message).toBe("ready");
    child[output]!.destroy();
    child.send("log");
    const [exitCode] = await exited;
    expect(exitCode, healthyOutput).toBe(0);
    expect(messages).toEqual(["ready", "continued"]);
    expect(healthyOutput).toBe("healthy output\n");
  } finally { child.kill(); }
});

it("keeps other output errors visible", () => {
  const stream = new PassThrough();
  ignoreBrokenPipeErrors(stream);
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  expect(() => stream.emit("error", error)).toThrow(error);
});

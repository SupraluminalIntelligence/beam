import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const desktop = new URL("../", import.meta.url);
const dist = new URL("dist/", desktop);
mkdirSync(dist, { recursive: true });
switch (process.argv[2]) {
  case "icon":
    copyFileSync(new URL("build/beam-light-cone.png", desktop), new URL("icon.png", dist));
    break;
  case "worker":
    copyFileSync(new URL("../runner/src/compute/worker.mjs", desktop), new URL("worker.mjs", dist));
    break;
  case "web": {
    const target = fileURLToPath(new URL("web/", dist));
    rmSync(target, { recursive: true, force: true });
    cpSync(new URL("../web/dist/", desktop), target, { recursive: true });
    break;
  }
  default: throw new Error("Expected icon, worker or web");
}

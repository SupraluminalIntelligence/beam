import { sampleModel } from "./sample";
import { parseCad } from "./parse";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

self.onmessage = async (event: MessageEvent<{ name: string; bytes: ArrayBuffer; sample?: boolean }>) => {
  try {
    const { name, bytes, sample } = event.data;
    const model = sample ? sampleModel() : await parseCad(name, bytes, async () => {
      const { default: initialize } = await import("occt-import-js");
      return initialize({ locateFile: () => wasmUrl, print: () => {}, printErr: () => {} });
    });
    const transfer = model.meshes.flatMap(mesh => [mesh.positions.buffer, ...(mesh.normals ? [mesh.normals.buffer] : []), ...(mesh.indices ? [mesh.indices.buffer] : [])]);
    self.postMessage({ model }, { transfer });
  } catch (e) { self.postMessage({ error: e instanceof Error ? e.message : "This file could not be read as a model." }); }
};

import { FieldPreview, previewByteLengths, type ResultField } from "@beam/contracts";

export type Output = { path: string; size: number; url: string | null };
export type Loaded = { preview: FieldPreview; positions: Float32Array; indices: Uint32Array; arrays: Map<string, Float32Array> };
const MAX_BYTES = 64 * 1024 * 1024;

/** Every preview file, checked against the lengths its description implies, so a truncated upload is never drawn. */
export async function load(field: ResultField, outputs: Output[], kept: string[], signal: AbortSignal): Promise<Loaded> {
  const find = (rel: string) => outputs.find(o => o.path === `beam/out/${rel}`);
  const fetchOk = async (rel: string) => {
    const o = find(rel);
    if (!o?.url) throw new Error(kept.includes(`beam/out/${rel}`) ? `${rel} is larger than the upload limit, so it stayed on the machine. Download the full data instead.` : `${rel} was not published.`);
    if (o.size > MAX_BYTES) throw new Error(`${rel} is too large to draw here.`);
    const r = await fetch(o.url, { signal });
    if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`);
    return r;
  };
  const preview = FieldPreview.parse(await (await fetchOk(field.preview)).json());
  const sizes = previewByteLengths(preview);
  const bytes = async (rel: string) => {
    const b = await (await fetchOk(rel)).arrayBuffer();
    if (b.byteLength !== sizes[rel]) throw new Error(`${rel} is ${b.byteLength} bytes; its preview says ${sizes[rel]}.`);
    return b;
  };
  const [p, i, ...a] = await Promise.all([bytes(preview.positions), bytes(preview.indices), ...preview.arrays.map(x => bytes(x.data))]);
  const indices = new Uint32Array(i);
  for (const v of indices) if (v >= preview.vertices) throw new Error("The preview's triangles refer to vertices it does not have.");
  return { preview, positions: new Float32Array(p), indices, arrays: new Map(preview.arrays.map((x, k) => [x.name, new Float32Array(a[k]!)])) };
}

/** A factor of the form 1, 2 or 5 × 10ⁿ near v. */
export const nice = (v: number) => { const m = 10 ** Math.floor(Math.log10(v)), f = v / m; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * m; };


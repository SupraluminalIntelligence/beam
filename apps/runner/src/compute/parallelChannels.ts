import { ParallelChannelsCase, gravityVector, parallelHeatInput, parallelLayout, type ParallelChannelsResults } from "@beam/contracts";
import { patchRanges, patchValues } from "./channelMetrics.ts";

/** One-cell extrusion of the 2-D device, in metres. */
export const PARALLEL_DEPTH = 0.001;
const header = (object: string, klass = "dictionary") => `FoamFile { version 2.0; format ascii; class ${klass}; object ${object}; }\n`;
export const channelPatch = (k: number) => `channel${k + 1}`;

/**
 * blockMesh and buoyantBoussinesqPimpleFoam files for parallel channels between two manifolds.
 * Blocks form a 3 × (2n − 1) grid: inlet manifold, channels, outlet manifold along x; channels and the solid walls between them along y.
 * The channel-section blocks at wall layers are left out, so those walls are holes in the fluid. Every channel has its own wall patch
 * (its floor and ceiling), heated or not, so the mesh does not depend on the heat fluxes.
 */
export function parallelFiles(raw: ParallelChannelsCase): Record<string, string> {
  const c = ParallelChannelsCase.parse(raw), L = parallelLayout(c), Z = PARALLEL_DEPTH, n = L.n, h = c.channelHeight;
  const xs = [0, c.manifoldLength, c.manifoldLength + c.channelLength, 2 * c.manifoldLength + c.channelLength];
  const ys = L.channelBottoms.flatMap(b => [b, b + h]), rows = ys.length;
  const v = (i: number, j: number, k: number) => k * 4 * rows + j * 4 + i;
  const vertices = [0, 1].flatMap(k => ys.flatMap((y, j) => xs.map(x => `(${x} ${y} ${k * Z})`)));
  const blocks: string[] = [], front: string[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < rows - 1; j++) {
    if (i === 1 && j % 2 === 1) continue;
    const hex = [v(i, j, 0), v(i + 1, j, 0), v(i + 1, j + 1, 0), v(i, j + 1, 0), v(i, j, 1), v(i + 1, j, 1), v(i + 1, j + 1, 1), v(i, j + 1, 1)];
    blocks.push(`hex (${hex.join(" ")}) (${i === 1 ? c.cellsAlong : L.manifoldCells} ${j % 2 ? L.wallCells : c.cellsAcross} 1) simpleGrading (1 1 1)`);
    front.push(`(${hex[0]} ${hex[3]} ${hex[2]} ${hex[1]})`, `(${hex[4]} ${hex[5]} ${hex[6]} ${hex[7]})`);
  }
  const xFace = (i: number, j: number) => `(${v(i, j, 0)} ${v(i, j, 1)} ${v(i, j + 1, 1)} ${v(i, j + 1, 0)})`;
  const yFace = (i: number, j: number) => `(${v(i, j, 0)} ${v(i + 1, j, 0)} ${v(i + 1, j, 1)} ${v(i, j, 1)})`;
  const layers = Array.from({ length: rows - 1 }, (_, j) => j), walls = layers.filter(j => j % 2);
  const patches = [
    `inlet {type patch; faces (${layers.map(j => xFace(0, j)).join(" ")});}`,
    `outlet {type patch; faces (${layers.map(j => xFace(3, j)).join(" ")});}`,
    `walls {type wall; faces (${[yFace(0, 0), yFace(2, 0), yFace(0, rows - 1), yFace(2, rows - 1), ...walls.flatMap(j => [xFace(1, j), xFace(2, j)])].join(" ")});}`,
    ...c.channels.map((_, k) => `${channelPatch(k)} {type wall; faces (${yFace(1, 2 * k)} ${yFace(1, 2 * k + 1)});}`),
    `frontAndBack {type empty; faces (${front.join(" ")});}`,
  ];
  const [gx, gy] = gravityVector(c.gravity), heated = c.channels.map((ch, k) => [channelPatch(k), ch.heatFlux] as const);
  const field = (name: string, dim: string, initial: string, bc: string, vector = false) => header(name, vector ? "volVectorField" : "volScalarField") + `dimensions ${dim};\ninternalField uniform ${initial};\nboundaryField { ${bc} frontAndBack { type empty; } }\n`;
  const noSlip = `walls {type noSlip;} ${heated.map(([p]) => `${p} {type noSlip;}`).join(" ")}`;
  // Parabolic inlet: u(y) = 6·U·(y/H)(1 − y/H) has mean U. fixedProfile raises y to vector exponents component by component.
  const inletU = c.inletProfile === "uniform" ? `fixedValue; value uniform (${c.velocity} 0 0)` : `fixedProfile; profile polynomial (((${6 * c.velocity / L.height} 0 0) (1 1 1)) ((${-6 * c.velocity / L.height ** 2} 0 0) (2 2 2))); direction (0 1 0); origin 0`;
  const Tin = c.inletTemperature;
  return {
    "system/blockMeshDict": header("blockMeshDict") + `scale 1; vertices (${vertices.join(" ")}); blocks (${blocks.join(" ")}); edges (); boundary (${patches.join(" ")}); mergePatchPairs ();`,
    "system/controlDict": header("controlDict") + `application buoyantBoussinesqPimpleFoam; startFrom startTime; startTime 0; stopAt endTime; endTime ${c.duration}; deltaT 1e-4; adjustTimeStep yes; maxCo 0.8; maxDeltaT ${c.duration / c.frames}; writeControl adjustableRunTime; writeInterval ${c.duration / c.frames}; purgeWrite 0; writeFormat ascii; writePrecision 12; writeCompression off; timeFormat general; timePrecision 8; runTimeModifiable false;`,
    "system/fvSchemes": header("fvSchemes") + `ddtSchemes {default Euler;} gradSchemes {default Gauss linear;} divSchemes {default none; div(phi,U) Gauss linearUpwind grad(U); div(phi,T) Gauss limitedLinear 1; div((nuEff*dev2(T(grad(U))))) Gauss linear;} laplacianSchemes {default Gauss linear corrected;} interpolationSchemes {default linear;} snGradSchemes {default corrected;}`,
    "system/fvSolution": header("fvSolution") + `solvers {p_rgh {solver GAMG; smoother DIC; tolerance 1e-9; relTol 0.01;} p_rghFinal {$p_rgh; relTol 0;} "(U|T)" {solver PBiCGStab; preconditioner DILU; tolerance 1e-10; relTol 0.01;} "(U|T)Final" {$U; relTol 0;}} PIMPLE {momentumPredictor yes; nOuterCorrectors 1; nCorrectors 2; nNonOrthogonalCorrectors 0;}`,
    "constant/transportProperties": header("transportProperties") + `transportModel Newtonian; nu ${c.nu}; beta ${c.beta}; TRef ${Tin}; Pr ${c.pr}; Prt 0.85;`,
    "constant/turbulenceProperties": header("turbulenceProperties") + "simulationType laminar;",
    "constant/g": header("g", "uniformDimensionedVectorField") + `dimensions [0 1 -2 0 0 0 0]; value (${gx} ${gy} 0);`,
    // The fluid starts at rest at the inlet temperature and the inlet flow and heating start at t = 0.
    "0/U": field("U", "[0 1 -1 0 0 0 0]", "(0 0 0)", `inlet {type ${inletU};} outlet {type inletOutlet; inletValue uniform (0 0 0); value uniform (0 0 0);} ${noSlip}`, true),
    "0/p_rgh": field("p_rgh", "[0 2 -2 0 0 0 0]", "0", `inlet {type fixedFluxPressure; value uniform 0;} outlet {type fixedValue; value uniform 0;} walls {type fixedFluxPressure; value uniform 0;} ${heated.map(([p]) => `${p} {type fixedFluxPressure; value uniform 0;}`).join(" ")}`),
    "0/p": field("p", "[0 2 -2 0 0 0 0]", "0", `".*" {type calculated; value uniform 0;}`),
    "0/T": field("T", "[0 0 0 1 0 0 0]", String(Tin), `inlet {type fixedValue; value uniform ${Tin};} outlet {type inletOutlet; inletValue uniform ${Tin}; value uniform ${Tin};} walls {type zeroGradient;} ${heated.map(([p, q]) => `${p} {type ${q > 0 ? `fixedGradient; gradient uniform ${q / c.conductivity}` : "zeroGradient"};}`).join(" ")}`),
    "0/alphat": field("alphat", "[0 2 -1 0 0 0 0]", "0", `".*" {type calculated; value uniform 0;}`),
  };
}

export type ParallelMesh = { centres: [number, number][]; owner: number[]; neighbour: number[]; boundary: string };
export type ParallelTime = { time: number; phi: number[] };

/**
 * Flows, temperatures and the energy balance of a parallel-channel solve, from the solver's own face fluxes.
 * A channel's flow is the flux through the face plane nearest its mid-length; with no other openings, every plane in a channel carries the same flux.
 * Exit bulk temperatures are for fluid leaving each channel: at the downstream end, or at the upstream end when the channel runs backwards.
 * Only faces carrying fluid out of the channel count, each weighted by its flux with the channel-side cell's temperature, so local backflow cannot drag the value outside the range of what leaves.
 * Heated wall temperatures add the imposed gradient over the half cell to the wall cell's value.
 * Heat leaving is counted by parallelHeatLeaving; at a steady state it equals the heat input.
 */
export function parallelResults(c: ParallelChannelsCase, mesh: ParallelMesh, times: ParallelTime[], lastPhiText: string, T: number[]) {
  const L = parallelLayout(c), h = c.channelHeight, dx = c.channelLength / c.cellsAlong, dy = h / c.cellsAcross, x0 = c.manifoldLength;
  const tol = 1e-3 * Math.min(dx, dy), { centres, owner, neighbour } = mesh;
  // Internal faces on the plane x = xPlane between two cells of the same row inside channel k, with +1 when the owner is upstream.
  const plane = (k: number, xPlane: number) => {
    const bottom = L.channelBottoms[k]!, faces: [number, number][] = [];
    for (let f = 0; f < neighbour.length; f++) {
      const a = centres[owner[f]!]!, b = centres[neighbour[f]!]!;
      if (Math.abs(a[1] - b[1]) < tol && a[1] > bottom && a[1] < bottom + h && Math.min(a[0], b[0]) < xPlane && Math.max(a[0], b[0]) > xPlane) faces.push([f, a[0] < b[0] ? 1 : -1]);
    }
    if (faces.length !== c.cellsAcross) throw new Error(`Channel ${k + 1} plane at x = ${xPlane} has ${faces.length} faces, expected ${c.cellsAcross}`);
    return faces;
  };
  const mid = c.channels.map((_, k) => plane(k, x0 + Math.round(c.cellsAlong / 2) * dx)), ends = c.channels.map((_, k) => [plane(k, x0), plane(k, x0 + c.channelLength)] as const);
  const flows = (phi: number[]) => mid.map(faces => faces.reduce((s, [f, sign]) => s + sign * phi[f]!, 0) / PARALLEL_DEPTH);
  const last = times.at(-1);
  if (!last) throw new Error("Solver produced no time directory");
  const ranges = patchRanges(mesh.boundary), patchFlux = (name: string) => { const r = ranges[name]; if (!r) throw new Error(`Missing ${name} patch`); return { cells: owner.slice(r.start, r.start + r.count), flux: patchValues(lastPhiText, name, r.count) }; };
  const inlet = patchFlux("inlet"), outlet = patchFlux("outlet"), inflow = -inlet.flux.reduce((s, f) => s + f, 0) / PARALLEL_DEPTH, outflow = outlet.flux.reduce((s, f) => s + f, 0) / PARALLEL_DEPTH;
  if (!(inflow > 0)) throw new Error("Inlet flux has the wrong direction");
  const final = flows(last.phi);
  const exitBulk = ends.map(([start, end], k) => {
    const net = final[k]!;
    if (Math.abs(net) < 0.02 * inflow) return null;
    // Forward flow leaves through the downstream end; reversed flow through the upstream end, where leaving means a negative streamwise flux.
    const faces = net > 0 ? end : start, out = net > 0 ? 1 : -1;
    let flux = 0, heat = 0;
    for (const [f, sign] of faces) {
      const leaving = out * sign * last.phi[f]!;
      if (leaving <= 0) continue;
      // The channel-side cell is upwind of a leaving face: the upstream cell of the streamwise pair at the downstream end, the downstream one at the upstream end.
      const upstream = sign > 0 ? owner[f]! : neighbour[f]!, downstream = sign > 0 ? neighbour[f]! : owner[f]!;
      flux += leaving; heat += leaving * T[net > 0 ? upstream : downstream]!;
    }
    return flux > 0 ? heat / flux : null;
  });
  let maxWall: number | null = null;
  c.channels.forEach((ch, k) => { if (ch.heatFlux <= 0) return; const r = ranges[`channel${k + 1}`]; if (!r) throw new Error(`Missing channel${k + 1} patch`); for (const cell of owner.slice(r.start, r.start + r.count)) maxWall = Math.max(maxWall ?? -Infinity, T[cell]! + ch.heatFlux / c.conductivity * dy / 2); });
  const leaving = parallelHeatLeaving(c, centres, T, inlet, outlet);
  const results: ParallelChannelsResults = {
    inflow, flows: final, history: times.map(t => ({ time: t.time, flows: flows(t.phi) })), exitBulkTemperaturesK: exitBulk,
    maxHeatedWallTemperatureK: maxWall, heatInputW: parallelHeatInput(c), heatCarriedOutW: leaving.heatW,
  };
  return { results, massImbalance: (outflow - inflow) / inflow, outletTemperatureK: leaving.outletTemperatureK };
}

type Patch = { cells: number[]; flux: number[] };
/**
 * Heat leaving the device per metre of depth, W/m, above the inlet temperature: ρ·cp·Σ φ·(T − T_in) over outflowing outlet faces, with ρ·cp = k·Pr/ν,
 * plus conduction out through every face held at T_in, k·(T − T_in)/d with d the cell centre's distance from the face. Those are the whole inlet,
 * and outlet faces where fluid flows back in, which inletOutlet fixes at T_in; fluid entering at T_in carries no heat above it.
 * The outlet temperature averages outflowing faces only.
 */
export function parallelHeatLeaving(c: ParallelChannelsCase, centres: [number, number][], T: number[], inlet: Patch, outlet: Patch) {
  const L = parallelLayout(c), h = c.channelHeight, dy = h / c.cellsAcross, xOut = 2 * c.manifoldLength + c.channelLength, rhoCp = c.conductivity * c.pr / c.nu;
  const faceHeight = (y: number) => L.channelBottoms.some(b => y > b && y < b + h) ? dy : c.wallThickness / L.wallCells;
  const conduction = (cell: number, distance: number) => c.conductivity * (T[cell]! - c.inletTemperature) / distance * faceHeight(centres[cell]![1]);
  let outward = 0, advected = 0, conducted = inlet.cells.reduce((s, cell) => s + conduction(cell, centres[cell]![0]), 0);
  outlet.flux.forEach((f, i) => {
    const cell = outlet.cells[i]!;
    if (f > 0) { outward += f; advected += f * (T[cell]! - c.inletTemperature); }
    else if (f < 0) conducted += conduction(cell, xOut - centres[cell]![0]);
  });
  return { heatW: advected / PARALLEL_DEPTH * rhoCp + conducted, outletTemperatureK: outward > 0 ? c.inletTemperature + advected / outward : null };
}


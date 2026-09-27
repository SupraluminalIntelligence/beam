import { z } from "zod";
import type { SetupCheck } from "./channelChecks.ts";

/**
 * Gravity relative to the device. stacked: channels one above another, channel 1 lowest, flow horizontal.
 * upflow and downflow: channels side by side in a vertical device, flow against or with gravity.
 */
export const GravityOrientation = z.enum(["off", "stacked", "upflow", "downflow"]);
export type GravityOrientation = z.infer<typeof GravityOrientation>;
const G = 9.81;
export const gravityVector = (g: GravityOrientation): [number, number] => g === "stacked" ? [0, -G] : g === "upflow" ? [-G, 0] : g === "downflow" ? [G, 0] : [0, 0];

/** The most cells a parallel-channel mesh may have; the exported field budget is 12,800. */
export const PARALLEL_CELL_BUDGET = 12000;
/** Largest cell aspect ratio, dx/dy or dy/dx; checkMesh starts failing around 40. */
const MAX_ASPECT = 20;

/**
 * Parallel channels between an inlet and an outlet manifold: a 2-D multi-channel heat exchanger or cold plate, transient, laminar, with buoyancy.
 * Channels have equal height and are separated by solid walls of one thickness; the manifolds span all channels and walls. SI units.
 * Each channel's heat flux enters the fluid through both of its walls; zero means adiabatic.
 */
export const ParallelChannelsCase = z.object({
  version: z.literal(1), geometry: z.literal("parallel-channels"),
  channelLength: z.number().min(0.005).max(0.5), channelHeight: z.number().min(0.0005).max(0.05),
  wallThickness: z.number().min(0.0005).max(0.05), manifoldLength: z.number().min(0.005).max(0.5),
  channels: z.array(z.object({ heatFlux: z.number().min(0).max(1e6) }).strict()).min(2).max(4),
  velocity: z.number().positive().max(1), inletProfile: z.enum(["uniform", "parabolic"]),
  inletTemperature: z.number().min(200).max(500),
  nu: z.number().min(1e-8).max(0.01), pr: z.number().min(0.01).max(1000), density: z.number().min(0.1).max(20000),
  conductivity: z.number().min(0.01).max(500), beta: z.number().min(0).max(0.02),
  // Stated for the single-phase check only; the solve never boils.
  boilingPoint: z.number().min(100).max(1000).optional(),
  gravity: GravityOrientation,
  cellsAcross: z.number().int().min(4).max(40), cellsAlong: z.number().int().min(10).max(200),
  duration: z.number().min(0.1).max(600), frames: z.number().int().min(2).max(60),
}).strict().superRefine((c, ctx) => {
  const layout = parallelLayout(c), issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (layout.cells > PARALLEL_CELL_BUDGET) issue(`This mesh has ${layout.cells.toLocaleString("en-US")} cells; the budget is ${PARALLEL_CELL_BUDGET.toLocaleString("en-US")}. Use fewer cells along or across the channels`);
  if (layout.maxAspect > MAX_ASPECT) issue(`Cells would be ${Math.round(layout.maxAspect)} times longer than they are high (or the reverse); keep that under ${MAX_ASPECT} by changing cells along or across`);
  if (layout.channelVelocity * 2 * c.channelHeight / c.nu > 1500) issue("This laminar model supports channel Reynolds numbers up to 1500 (on twice the channel height, with the flow split evenly)");
});
export type ParallelChannelsCase = z.infer<typeof ParallelChannelsCase>;

/** Mana Masrouri and Jamal Yagoobi's two-channel device (IJHMT 260, 128445, 2026) without its EHD pumps: HFE-7100 at 20 °C, lower channel heated at 0.75 W/cm². */
export const defaultParallelChannels: ParallelChannelsCase = {
  version: 1, geometry: "parallel-channels", channelLength: 0.07, channelHeight: 0.005, wallThickness: 0.005, manifoldLength: 0.07,
  channels: [{ heatFlux: 7500 }, { heatFlux: 0 }], velocity: 0.01, inletProfile: "uniform", inletTemperature: 293.15,
  nu: 3.8e-7, pr: 9.8, density: 1510, conductivity: 0.069, beta: 0.0018, boilingPoint: 334.15, gravity: "stacked",
  cellsAcross: 20, cellsAlong: 70, duration: 5, frames: 20,
};

/** Block layout shared by the mesher, the exporter and the checks. y runs across the channels, channel 1 at y = 0. */
export function parallelLayout(c: Pick<ParallelChannelsCase, "channels" | "channelHeight" | "wallThickness" | "channelLength" | "manifoldLength" | "cellsAcross" | "cellsAlong" | "velocity">) {
  const n = c.channels.length, h = c.channelHeight, s = c.wallThickness, height = n * h + (n - 1) * s;
  const wallCells = Math.max(1, Math.round(c.cellsAcross * s / h)), manifoldCells = Math.max(4, Math.round(c.cellsAlong * c.manifoldLength / c.channelLength));
  const dy = h / c.cellsAcross, dx = c.channelLength / c.cellsAlong, dxm = c.manifoldLength / manifoldCells, dys = s / wallCells;
  const aspect = (a: number, b: number) => Math.max(a / b, b / a);
  return {
    n, height, wallCells, manifoldCells,
    cells: 2 * manifoldCells * (n * c.cellsAcross + (n - 1) * wallCells) + n * c.cellsAcross * c.cellsAlong,
    maxAspect: Math.max(aspect(dx, dy), aspect(dxm, dy), aspect(dxm, dys)),
    /** Lower edge of each channel. */
    channelBottoms: Array.from({ length: n }, (_, i) => i * (h + s)),
    /** Mean velocity in each channel if the flow split evenly. */
    channelVelocity: c.velocity * height / (n * h),
  };
}

/** Results of a parallel-channel solve. Flows are volumetric per unit depth (m²/s), from the solver's face fluxes at each channel's mid-length. */
export const ParallelChannelsResults = z.object({
  inflow: z.number().finite(),
  flows: z.array(z.number().finite()).min(2).max(4),
  history: z.array(z.object({ time: z.number().finite(), flows: z.array(z.number().finite()).min(2).max(4) })).max(61),
  // Flow-weighted temperature of fluid leaving each channel, at the downstream end or, when a channel runs backwards, the upstream end.
  // Only faces carrying fluid out count; null while a channel's net flow is too small to define one.
  exitBulkTemperaturesK: z.array(z.number().finite().nullable()).min(2).max(4),
  maxHeatedWallTemperatureK: z.number().finite().nullable(),
  // Per metre of depth: heat entering through the heated walls, and heat leaving the device: carried out of the outlet above the inlet temperature,
  // plus any conducted back out through the inlet. At a steady state the two match.
  heatInputW: z.number().finite(), heatCarriedOutW: z.number().finite(),
});
export type ParallelChannelsResults = z.infer<typeof ParallelChannelsResults>;

/** Heat entering the fluid per metre of depth, W/m: each channel's flux through two walls of the channel's length. */
export const parallelHeatInput = (c: ParallelChannelsCase) => c.channels.reduce((s, ch) => s + 2 * ch.heatFlux * c.channelLength, 0);

/**
 * Hottest heated-wall temperature expected by the end of the run, in K, from the lesser of two bounds.
 * Steady: the bulk rise with the flow split evenly plus the developed wall-to-bulk difference, q''·2h/(k·8.235).
 * Transient: a wall heated from t = 0 with no flow, 2q''·√(α·t/π)/k, which bounds early times.
 */
export function parallelWallEstimate(c: ParallelChannelsCase, time = c.duration) {
  const q = Math.max(...c.channels.map(ch => ch.heatFlux));
  if (q <= 0) return null;
  const alpha = c.nu / c.pr, rhoCp = c.conductivity / alpha, u = parallelLayout(c).channelVelocity;
  const steady = 2 * q * c.channelLength / (rhoCp * u * c.channelHeight) + q * 2 * c.channelHeight / (c.conductivity * 8.235);
  const transient = 2 * q * Math.sqrt(alpha * time / Math.PI) / c.conductivity;
  return { steady, transient, wall: c.inletTemperature + Math.min(steady, transient), reachesAt: (dT: number) => Math.PI * (dT * c.conductivity / (2 * q)) ** 2 / alpha };
}

const num = (n: number) => n !== 0 && (Math.abs(n) >= 1e4 || Math.abs(n) < 1e-2) ? n.toExponential(1).replace("e+", "e") : String(Number(n.toPrecision(3)));
const kelvin = (t: number) => `${num(t)} K (${num(t - 273.15)} °C)`;
const seconds = (t: number) => t >= 120 ? `${num(t / 60)} min` : `${num(t)} s`;

/**
 * Checks the parallel-channel model's assumptions against its inputs before anything runs.
 * The model is laminar, single-phase and constant-property, with buoyancy by the Boussinesq approximation when gravity is on.
 * Dimensionless groups use twice the channel height and the channel velocity of an even split.
 */
export function parallelSetupChecks(c: ParallelChannelsCase): SetupCheck[] {
  const u = parallelLayout(c).channelVelocity, dh = 2 * c.channelHeight, re = u * dh / c.nu, alpha = c.nu / c.pr;
  const estimate = parallelWallEstimate(c), dT = estimate ? estimate.wall - c.inletTemperature : 0, heated = c.channels.some(ch => ch.heatFlux > 0);
  const checks: SetupCheck[] = [{ id: "laminar", label: "laminar flow", status: re <= 2000 ? "ok" : "fail", value: `Re ${num(re)}`,
    detail: `Re = U·2h/ν in each channel with the flow split evenly (U ${num(u)} m/s). Flow between parallel plates stays laminar below about 2,000; a channel that takes more of the flow runs at a higher Re.` }];

  const ri = G * c.beta * dT * dh / (u * u), where = estimate && estimate.transient < estimate.steady ? `by the end of the ${seconds(c.duration)} run` : "once steady";
  if (!heated) checks.push({ id: "buoyancy", label: c.gravity === "off" ? "gravity off" : "buoyancy", status: "ok", value: "no heating", detail: "No channel is heated, so there is no buoyancy to model or neglect." });
  else if (c.gravity === "off") checks.push({ id: "buoyancy", label: "gravity off", status: ri < 0.1 ? "ok" : ri < 1 ? "warn" : "fail", value: `Ri ${num(ri)}`,
    detail: `Ri = gβΔT·2h/U² with ΔT ${num(dT)} K, the estimated hottest wall ${where} minus the inlet. ` + (ri < 0.1 ? "Forced convection dominates, so leaving gravity out is reasonable."
      : "Buoyancy is not negligible, and in parallel channels it can shift the flow between channels as well as the heat transfer. Turn gravity on in the orientation of the real device.") });
  else checks.push({ id: "buoyancy", label: "buoyancy", status: c.beta * dT < 0.1 ? "info" : "warn", value: `Ri ${num(ri)}`,
    detail: `Gravity is on (${c.gravity}), so buoyancy is solved with the Boussinesq approximation: constant properties except a density that falls by β per kelvin. Ri = gβΔT·2h/U² with ΔT ${num(dT)} K, the estimated hottest wall ${where} minus the inlet. `
      + (ri >= 1 ? "Buoyancy is at least as strong as the flow's inertia, so it can set how the flow divides between channels. " : "")
      + (c.beta * dT < 0.1 ? `The density changes by about ${num(100 * c.beta * dT)} %, within the approximation's usual range.` : `The density changes by about ${num(100 * c.beta * dT)} %, beyond the roughly 10 % where the Boussinesq approximation is usually trusted.`) });

  if (c.gravity === "stacked" && heated) {
    const ra = G * c.beta * dT * c.channelHeight ** 3 / (c.nu * alpha);
    checks.push({ id: "convection-cells", label: "heated from below", status: ra > 1708 ? "warn" : "ok", value: `Ra ${num(ra)}`,
      detail: `Each heated channel's floor is heated, with its ceiling above it. Ra = gβΔT·h³/(ν·α) on the channel height. ` + (ra > 1708
        ? "Above about 1,708 a fluid layer heated from below forms convection rolls, so the flow can stay unsteady. Read the flow split over time, not from one snapshot."
        : "Below about 1,708 a fluid layer heated from below stays free of convection rolls.") });
  }

  if (c.boilingPoint !== undefined && c.inletTemperature >= c.boilingPoint) checks.push({ id: "single-phase", label: "single phase", status: "fail", value: "inlet at or above Tsat",
    detail: `The inlet, ${kelvin(c.inletTemperature)}, is at or above the stated boiling point of ${kelvin(c.boilingPoint)}, so the liquid would boil before any heating. This single-phase model cannot represent that; lower the inlet temperature or check the boiling point at the operating pressure.` });
  else if (!heated) checks.push({ id: "single-phase", label: "single phase", status: "ok", value: "no heating", detail: "No channel is heated, and the inlet is below the boiling point or none is set." });
  else if (c.boilingPoint === undefined) checks.push({ id: "single-phase", label: "single phase", status: "unknown", value: "boiling point not set", detail: "Set the saturation temperature at the operating pressure to check that no heated wall reaches it." });
  else {
    const margin = c.boilingPoint - estimate!.wall, reach = estimate!.reachesAt(c.boilingPoint - c.inletTemperature);
    checks.push({ id: "single-phase", label: "single phase", status: margin > 0 ? "ok" : "fail", value: margin > 0 ? `${num(margin)} K below Tsat` : `${num(-margin)} K above Tsat`,
      detail: `The hottest heated wall is estimated at ${kelvin(estimate!.wall)} ${where}, against a stated boiling point of ${kelvin(c.boilingPoint)}. The estimate is the lesser of a wall heated with no flow, 2q''·√(α·t/π)/k, and the developed steady value. `
        + (margin > 0 ? "" : `A wall heated with no flow reaches the boiling point after about ${seconds(reach)}. Liquid there can boil, which this single-phase model cannot represent, and the solver will still run because it has no phase change. The solve reports the actual maximum.`) });
  }

  const flowThrough = 2 * c.manifoldLength / c.velocity + c.channelLength / u;
  checks.push({ id: "run-length", label: "run length", status: c.duration >= 3 * flowThrough ? "ok" : c.duration >= flowThrough ? "info" : "warn", value: `${num(c.duration / flowThrough)} flow-throughs`,
    detail: `Fluid entering at t = 0 needs about ${seconds(flowThrough)} to cross both manifolds and a channel at the even-split velocity. ` + (c.duration < flowThrough
      ? `A ${seconds(c.duration)} run ends before it reaches the outlet, so the flow split, outlet temperatures and energy balance at the end describe a start-up transient, not a steady state.`
      : c.duration < 3 * flowThrough ? "The run spans fewer than three flow-through times; check that the flow split has stopped changing before calling it steady." : "The run spans at least three flow-through times; the flow history shows whether it settled.")
      + ` Heat diffuses across a channel in about h²/α = ${seconds(c.channelHeight ** 2 / alpha)}.` });

  if (c.density >= 100 && c.pr >= 0.1) checks.push({ id: "viscosity", label: "viscosity units", status: alpha > 1e-6 ? "warn" : "ok", value: `α ${num(alpha)} m²/s`,
    detail: alpha > 1e-6 ? `For a liquid, the thermal diffusivity these inputs imply, α = ν/Pr, is several times any common non-metallic liquid's (water's is about 1.4e-7 m²/s). A dynamic viscosity in Pa·s entered as kinematic viscosity does this. If ${num(c.nu)} is in Pa·s, the kinematic viscosity is ${num(c.nu / c.density)} m²/s.`
      : "Viscosity, Prandtl number and density give a thermal diffusivity, α = ν/Pr, in the range of ordinary liquids." });
  else checks.push({ id: "viscosity", label: "viscosity units", status: "info", value: `α ${num(alpha)} m²/s`, detail: "α = ν/Pr. Units are only cross-checked for non-metallic liquids." });
  return checks;
}

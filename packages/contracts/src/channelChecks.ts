import type { ChannelCase } from "./simulation.ts";

/** ok: the assumption holds for these inputs · warn: worth a look · fail: the model does not represent this flow · unknown: needs stated fluid data · info: context, not a verdict. */
export type SetupCheckStatus = "ok" | "warn" | "fail" | "unknown" | "info";
export type SetupCheck = { id: "laminar" | "buoyancy" | "single-phase" | "viscosity" | "development"; label: string; status: SetupCheckStatus; value: string; detail: string };

const G = 9.81;
/** Fully developed Nusselt number for parallel plates with both walls at one fixed temperature, on 2H (Shah & London 1978). */
export const PLATES_NU_T = 7.54;
/** Darcy friction factor times Re for fully developed laminar flow between parallel plates, on 2H. */
export const PLATES_FRE = 96;
/** Hydrodynamic (Chen 1973) and thermal (Shah & London, uniform wall temperature) entry lengths in metres. */
export function channelEntryLengths(c: ChannelCase) {
  const dh = 2 * c.height, re = c.velocity * dh / c.nu;
  return { flow: dh * (0.315 / (1 + 0.0175 * re) + 0.011 * re), heat: 0.008 * re * c.pr * dh };
}
const num = (n: number) => n !== 0 && (Math.abs(n) >= 1e4 || Math.abs(n) < 1e-2) ? n.toExponential(1).replace("e+", "e") : String(Number(n.toPrecision(3)));
const kelvin = (t: number) => `${num(t)} K (${num(t - 273.15)} °C)`;
const metres = (m: number) => m >= 1 ? `${num(m)} m` : m >= 0.01 ? `${num(m * 100)} cm` : `${num(m * 1000)} mm`;

/**
 * Checks the heated channel's modelling assumptions against its inputs, before anything runs.
 * The recipe is steady, laminar, single-phase and constant-property with gravity off; these checks say when the inputs break that.
 * Dimensionless groups use the hydraulic diameter 2H. Correlations are Shah & London (1978) for parallel plates.
 */
export function channelSetupChecks(c: ChannelCase): SetupCheck[] {
  const dh = 2 * c.height, re = c.velocity * dh / c.nu, alpha = c.nu / c.pr, dT = c.thermal ? Math.abs(c.wallTemperature - c.inletTemperature) : 0;
  const checks: SetupCheck[] = [{ id: "laminar", label: "laminar flow", status: re <= 2000 ? "ok" : "fail", value: `Re ${num(re)}`,
    detail: `Re = U·2H/ν. Flow between parallel plates is expected to stay laminar below about 2,000 on this length scale.` }];

  if (dT === 0) checks.push({ id: "buoyancy", label: "gravity off", status: "ok", value: "no heating", detail: "Walls and inlet are at the same temperature or the walls are adiabatic, so there is no buoyancy to neglect." });
  else if (c.beta === undefined) checks.push({ id: "buoyancy", label: "gravity off", status: "unknown", value: "β not set",
    detail: "This model turns gravity off. Set the fluid's thermal expansion coefficient β to check that buoyancy is negligible." });
  else {
    const ri = G * c.beta * dT * dh / (c.velocity * c.velocity), gr = ri * re * re;
    checks.push({ id: "buoyancy", label: "gravity off", status: ri < 0.1 ? "ok" : ri < 1 ? "warn" : "fail", value: `Ri ${num(ri)}`,
      detail: `Ri = Gr/Re² = gβΔT·2H/U² with ΔT ${num(dT)} K (Gr ${num(gr)}). ` + (ri < 0.1 ? "Forced convection dominates, so leaving gravity out is reasonable."
        : ri < 1 ? "Mixed convection: buoyancy is not negligible here, and a real channel will differ from this gravity-free result, more so in a horizontal one."
        : "Buoyancy is as strong as or stronger than the flow's inertia, but this model turns gravity off. The computed fields do not represent the real flow in any orientation. Lower ΔT or the gap, or raise the velocity.") });
  }

  const hottest = c.thermal ? Math.max(c.wallTemperature, c.inletTemperature) : c.inletTemperature, where = c.thermal && c.wallTemperature >= c.inletTemperature ? "Wall" : "Inlet";
  if (c.boilingPoint === undefined) checks.push({ id: "single-phase", label: "single phase", status: "unknown", value: "boiling point not set",
    detail: "Set the saturation temperature at the operating pressure to check that no part of the liquid reaches it." });
  else checks.push({ id: "single-phase", label: "single phase", status: hottest < c.boilingPoint ? "ok" : "fail",
    value: hottest < c.boilingPoint ? `${num(c.boilingPoint - hottest)} K below Tsat` : `${num(hottest - c.boilingPoint)} K above Tsat`,
    detail: hottest < c.boilingPoint ? `The hottest surface, ${kelvin(hottest)}, stays below the stated boiling point of ${kelvin(c.boilingPoint)}.`
      : `${where} temperature ${kelvin(hottest)} is at or above the stated boiling point of ${kelvin(c.boilingPoint)}. Liquid there can boil, which this single-phase model cannot represent. The solver will still converge because it has no phase change.` });

  // A dynamic viscosity (Pa·s) entered as kinematic (m²/s) makes ν/Pr far larger than any non-metallic liquid's diffusivity; water's is 1.4e-7 m²/s.
  if (c.density >= 100 && c.pr >= 0.1) checks.push({ id: "viscosity", label: "viscosity units", status: alpha > 1e-6 ? "warn" : "ok", value: `α ${num(alpha)} m²/s`,
    detail: alpha > 1e-6 ? `For a liquid, the thermal diffusivity these inputs imply, α = ν/Pr, is several times any common non-metallic liquid's (water's is about 1.4e-7 m²/s). A dynamic viscosity in Pa·s entered as kinematic viscosity does this. If ${num(c.nu)} is in Pa·s, the kinematic viscosity is ${num(c.nu / c.density)} m²/s.`
      : "Viscosity, Prandtl number and density give a thermal diffusivity, α = ν/Pr, in the range of ordinary liquids." });
  else checks.push({ id: "viscosity", label: "viscosity units", status: "info", value: `α ${num(alpha)} m²/s`, detail: "α = ν/Pr. Units are only cross-checked for non-metallic liquids." });

  const { flow, heat } = channelEntryLengths(c);
  checks.push({ id: "development", label: "entry length", status: "info", value: c.thermal ? `${metres(flow)} / ${metres(heat)}` : metres(flow),
    detail: `Velocity develops over about ${metres(flow)}` + (c.thermal ? ` and temperature over about ${metres(heat)}, in a ${metres(c.length)} channel. ` + (heat < c.length
      ? `Both develop before the outlet, where the local Nusselt number should approach ${PLATES_NU_T} for two walls at fixed temperature.`
      : `Temperature is still developing at the outlet, so local Nusselt numbers stay above the fully developed ${PLATES_NU_T}.`) : ` in a ${metres(c.length)} channel.`) });
  return checks;
}

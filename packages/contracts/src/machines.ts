import { z } from "zod";

/**
 * Machines: where work runs. The engineer's own computer, or a cloud machine Beam allocates. Sizes are
 * a short fixed list so agents choose well; the spike (environments/spike/REPORT.md) put the line between
 * Modal and whole-node EC2 at 8 cores, where MPI on Modal stopped getting faster.
 */
export const MachineId = z.enum(["local", "chat", "8-core", "32-core", "96-core", "gpu-1", "gpu-8"]);
export type MachineId = z.infer<typeof MachineId>;
export const MachineBackend = z.enum(["local-docker", "modal-sandbox", "modal-function", "ec2"]);
export type MachineBackend = z.infer<typeof MachineBackend>;

export type MachineShape = {
  id: MachineId;
  label: string;
  location: "local" | "cloud";
  backend: MachineBackend;
  /** null: whatever the engineer's Docker allows. */
  cores: number | null;
  memoryGiB: number | null;
  gpus: { count: number; model: string } | null;
  /** Stays up for commands (a chat's machine) rather than running one job. */
  interactive: boolean;
  /** A whole host: no neighbours, full memory bandwidth. */
  wholeNode: boolean;
};

export const MACHINES: Record<MachineId, MachineShape> = {
  "local": { id: "local", label: "This computer", location: "local", backend: "local-docker", cores: null, memoryGiB: null, gpus: null, interactive: true, wholeNode: false },
  "chat": { id: "chat", label: "Chat machine · 4 cores", location: "cloud", backend: "modal-sandbox", cores: 4, memoryGiB: 16, gpus: null, interactive: true, wholeNode: false },
  "8-core": { id: "8-core", label: "8-core cloud machine", location: "cloud", backend: "modal-function", cores: 8, memoryGiB: 32, gpus: null, interactive: false, wholeNode: false },
  "32-core": { id: "32-core", label: "32-core cloud machine", location: "cloud", backend: "ec2", cores: 32, memoryGiB: 128, gpus: null, interactive: false, wholeNode: true },
  "96-core": { id: "96-core", label: "96-core cloud machine", location: "cloud", backend: "ec2", cores: 96, memoryGiB: 768, gpus: null, interactive: false, wholeNode: true },
  "gpu-1": { id: "gpu-1", label: "1-GPU cloud machine", location: "cloud", backend: "modal-function", cores: 8, memoryGiB: 64, gpus: { count: 1, model: "L40S" }, interactive: false, wholeNode: false },
  "gpu-8": { id: "gpu-8", label: "8-GPU cloud machine", location: "cloud", backend: "modal-function", cores: 64, memoryGiB: 512, gpus: { count: 8, model: "H100" }, interactive: false, wholeNode: false },
};

/** MPI processes worth starting on a machine: its cores, capped at 8 on Modal, where more made solves slower. */
export function usefulProcesses(machine: MachineShape, available = machine.cores ?? 1): number {
  const cores = Math.max(1, machine.cores ?? available);
  return machine.backend === "modal-function" || machine.backend === "modal-sandbox" ? Math.min(cores, 8) : cores;
}

/**
 * Modal's list prices for Sandboxes, in USD per second (modal.com/pricing, read 28 Sep 2026). Beam
 * charges cloud machines at cost until pricing is decided. A Modal core is a physical core, two vCPUs.
 */
const MODAL_SANDBOX_USD_PER_SECOND = { core: 0.00003942, memoryGiB: 0.00000667, gpu: { L40S: 0.000542, H100: 0.001097 } as Record<string, number> };

/** What a cloud machine costs per hour in US cents, or null when Beam cannot run it in the cloud yet. */
export function cloudCentsPerHour(machine: MachineShape): number | null {
  if (machine.backend !== "modal-sandbox" && machine.backend !== "modal-function") return null;
  const p = MODAL_SANDBOX_USD_PER_SECOND;
  const gpu = machine.gpus ? machine.gpus.count * (p.gpu[machine.gpus.model] ?? NaN) : 0;
  const usdPerSecond = machine.cores! * p.core + machine.memoryGiB! * p.memoryGiB + gpu;
  return Number.isFinite(usdPerSecond) ? usdPerSecond * 3600 * 100 : null;
}

/**
 * A cloud job's machine waits this long for its inputs and start signal, then holds finished results
 * this long for Beam to collect. Its whole life is capped, so the machine stops even if Beam never does.
 */
export const CLOUD_LAUNCH_WINDOW_SECONDS = 300;
export const CLOUD_COLLECT_WINDOW_SECONDS = 1800;
export const cloudMachineSeconds = (timeoutSeconds: number) => CLOUD_LAUNCH_WINDOW_SECONDS + timeoutSeconds + CLOUD_COLLECT_WINDOW_SECONDS;
/** Modal's longest sandbox life, so the longest job timeout a cloud machine can take. */
export const CLOUD_MAX_MACHINE_SECONDS = 24 * 3600;
export const CLOUD_MAX_TIMEOUT_SECONDS = CLOUD_MAX_MACHINE_SECONDS - CLOUD_LAUNCH_WINDOW_SECONDS - CLOUD_COLLECT_WINDOW_SECONDS;
/** Cents charged for a machine's time, rounded up to the cent. */
export const chargeCents = (centsPerHour: number, seconds: number) => Math.ceil((centsPerHour * Math.max(0, seconds)) / 3600);
/**
 * The most a job may spend: its machine's whole capped life. This is the amount approval authorizes and
 * the workspace budget reserves; what it actually spends is metered and usually far less.
 */
export const authorizedCents = (centsPerHour: number, timeoutSeconds: number) => chargeCents(centsPerHour, cloudMachineSeconds(timeoutSeconds));
export const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

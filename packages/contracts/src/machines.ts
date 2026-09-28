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

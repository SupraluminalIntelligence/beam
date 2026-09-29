import { describe, expect, it } from "vitest";
import { CLOUD_JOB_MACHINES, machineChoices } from "./environmentTools.ts";

describe("machineChoices", () => {
  const byId = (c: ReturnType<typeof machineChoices>) => Object.fromEntries(c.machines.map(m => [m.id, m]));

  it("offers cloud job machines with their price once the deployment runs them and the workspace has budget", () => {
    const choices = machineChoices({ enabled: true, availableCents: 2500 }), m = byId(choices);
    expect(choices.cloud).toEqual({ budgetLeft: "$25.00" });
    expect(m["local"]).toMatchObject({ available: true });
    expect(m["8-core"]).toMatchObject({ available: true, perHour: expect.stringMatching(/^\$\d+\.\d\d$/), mpiProcesses: 8 });
    // $25 cannot hold even a one-second job on eight H100s, whose start-up and collection alone cost more.
    expect(m["gpu-8"]).toMatchObject({ available: false, note: expect.stringContaining("smallest hold") });
    expect(m["gpu-1"]).toMatchObject({ available: true });
    // The chat machine is for commands, and EC2 machines cannot launch yet.
    expect(m["chat"]?.available).toBe(false);
    expect(m["32-core"]).toMatchObject({ available: false });
    expect(m["32-core"]).not.toHaveProperty("perHour");
    expect(CLOUD_JOB_MACHINES.map(x => x.id)).toEqual(["8-core", "gpu-1", "gpu-8"]);
  });

  it("keeps jobs local, and says why, when cloud is off, out of budget or unknown", () => {
    for (const [cloud, note] of [[{ enabled: false, availableCents: 5000 }, "not switched on"], [{ enabled: true, availableCents: 0 }, "no cloud compute budget left"], [null, "not switched on"]] as const) {
      const choices = machineChoices(cloud);
      expect(choices.machines.filter(m => m.available).map(m => m.id)).toEqual(["local"]);
      expect(choices.cloud.note).toContain(note);
    }
  });
});

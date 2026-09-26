import { describe, expect, it } from "vitest";
import { waitForApproval } from "./deviceCode";

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

describe("waiting on a device code", () => {
  it("returns approved once the code is approved", async () => {
    const answers = [{ status: "pending" }, { status: "pending" }, { status: "approved" }];
    expect(await waitForApproval({ ...clock(), status: async () => answers.shift()!, cancelled: () => false })).toBe("approved");
  });

  it("stops polling as soon as the wait is cancelled", async () => {
    let polls = 0;
    let off = false;
    const status = async () => { polls++; if (polls === 2) off = true; return { status: "pending" }; };
    expect(await waitForApproval({ ...clock(), status, cancelled: () => off })).toBe("cancelled");
    expect(polls).toBe(2);
  });

  it("does not report an approval that arrives after Cancel", async () => {
    let off = false;
    const status = async () => { off = true; return { status: "approved" }; };
    expect(await waitForApproval({ ...clock(), status, cancelled: () => off })).toBe("cancelled");
  });

  it("treats a missing or unreadable code as expired", async () => {
    expect(await waitForApproval({ ...clock(), status: async () => null, cancelled: () => false })).toBe("expired");
    expect(await waitForApproval({ ...clock(), status: () => Promise.reject(new Error("offline")), cancelled: () => false })).toBe("expired");
  });

  it("gives up after the limit", async () => {
    let polls = 0;
    const status = async () => { polls++; return { status: "pending" }; };
    expect(await waitForApproval({ ...clock(), status, cancelled: () => false, everyMs: 1000, limitMs: 5000 })).toBe("timeout");
    expect(polls).toBe(5);
  });
});

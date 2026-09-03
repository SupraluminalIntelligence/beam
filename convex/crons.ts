import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("sync open changes with GitHub", { minutes: 3 }, internal.github.syncChanges, {});
crons.interval("reap stale runs", { minutes: 2 }, internal.runs.reapStale, {});
export default crons;

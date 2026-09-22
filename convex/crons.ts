import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("sync open changes with GitHub", { minutes: 3 }, internal.github.syncChanges, {});
crons.interval("reap stale runs", { minutes: 2 }, internal.runs.reapStale, {});
crons.interval("expire typing activity", { minutes: 5 }, internal.presence.cleanTyping, {});
crons.interval("expire unsent file uploads", { hours: 24 }, internal.files.cleanup, {});
export default crons;

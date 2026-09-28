/**
 * The entrypoint of every job sandbox. It is the cloud twin of the local worker's receipts: the gateway
 * can restart at any point and still learn what happened from files in the sandbox.
 *
 * It waits for the gateway to write `go` after the inputs are in place, or `abort` when staging failed,
 * and gives up after the launch window, so a launch the gateway abandoned never starts on its own. The
 * command's log and exit code land in the job directory, then the sandbox stays up so the gateway can
 * collect outputs; the sandbox's own lifetime ends it if nobody does.
 */
export const SUPERVISOR = [
  "set -u",
  'J="${BEAM_JOB_DIR:-/tmp/beam-job}"',
  'W="${BEAM_WORK:-/work}"',
  'mkdir -p "$J" "$W"',
  'while [ ! -e "$J/go" ]; do',
  '  if [ -e "$J/abort" ]; then exec sleep "${BEAM_HOLD_SECONDS:-infinity}"; fi',
  '  if [ "$SECONDS" -ge "${BEAM_LAUNCH_WINDOW:-600}" ]; then exit 97; fi',
  "  sleep 0.2",
  "done",
  'cd "$W"',
  "started=$SECONDS",
  'timeout --signal=TERM --kill-after="${BEAM_KILL_AFTER:-15}" "$BEAM_TIMEOUT" bash -lc "$BEAM_COMMAND" > "$J/log" 2>&1 < /dev/null',
  "code=$?",
  // A command that ignores TERM is killed after the grace period and timeout exits 137, the same code
  // as an out-of-memory kill; only the elapsed time tells them apart.
  'if [ "$code" -eq 137 ] && [ $((SECONDS - started)) -ge "$BEAM_TIMEOUT" ]; then code=124; fi',
  `printf '%s' "$code" > "$J/exit.tmp" && mv "$J/exit.tmp" "$J/exit"`,
  'exec sleep "${BEAM_HOLD_SECONDS:-infinity}"',
].join("\n");

/** The supervisor's exit code when no `go` arrived within the launch window. */
export const LAUNCH_ABANDONED = 97;
/** coreutils timeout's exit code when the command ran past its limit, also recorded when it had to be killed. */
export const TIMED_OUT = 124;

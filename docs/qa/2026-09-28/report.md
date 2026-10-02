# Beam desktop QA, September 27, 2026

Hands-on pass through the installed **Beam 0.1.10 (0.1.10)** on George's MacBook Pro, using the Computer Use plugin. Local date: September 27, EDT; evidence folder uses September 28, UTC. This assesses the installed release, not the current checkout or unreleased changes.

**Fix draft loss and Settings focus first.** Navigation, saved simulation playback, CAD sample rendering, browser navigation, and a real local compute job worked. Six defects and seven UX improvements are recorded below. Priorities are proposed: P1 means user work or unintended-action risk, P2 means meaningful workflow friction, P3 means polish.

## Defects

### B1 · P1 · Switching chats discards unsent text

**Reproduction:** Open a private chat; type an unsent message; click another chat in the sidebar; return to the private chat.

**Observed:** The composer is empty and Send is disabled. The saved before/after screenshots show this with `QA draft persistence probe` after the private chat contained a completed compute job. This reproduction used typing, without clipboard automation.

**Expected:** Each chat retains its draft when navigating, including line breaks and any routing information. Persist through reload where practical.

**Impact:** Looking up context in another chat destroys work without warning.

**Evidence:** [Before switching](41-draft-before-switch.png), [after returning](43-draft-lost-repeat.png).

### B2 · P1 · Settings leaves keyboard focus in the underlying composer

**Reproduction:** Click the composer; open Settings with ⌘,; type `QA focus probe` without clicking anything in Settings.

**Observed:** Settings is visible, but the composer behind it contains `QA focus probe` and its Send button is enabled. The saved screenshot shows the changed composer beneath Settings; it does not establish the accessibility focus target.

**Expected:** Opening Settings moves focus into the dialog, traps keyboard navigation there, and makes underlying controls inactive until it closes. Closing restores focus.

**Impact:** Users can edit a hidden draft while interacting with Settings. An unintended send is a plausible consequence, but Enter was deliberately not tested and no agent prompt was sent.

**Evidence:** [Settings with underlying input changed](21-modal-underlying-text.png), [Settings opened from browser](50-settings-over-browser.png). The browser capture shows the overlay, but does not establish keyboard focus.

### B3 · P2 · Shell syntax is rendered as mathematical notation

**Reproduction:** In `testbed`, open `just another test page` and inspect the 12:57 message asking Claude to run a shell loop.

**Observed:** The middle of the loop appears in math italics, with words and numbers compressed together, followed by ordinary `sleep 1; done`. The displayed command has lost its readable shell form. An exact accessibility transcription is unavailable.

**Expected:** Shell expressions remain literal. The existing example suggests dollar-delimited math parsing is consuming shell variable syntax; that cause is an inference, not a source-level diagnosis. Provide a raw-message view/copy option and test shell expressions alongside genuine math.

**Impact:** Technical messages become misleading and difficult to read. Copy behavior and stored original text were not tested.

**Evidence:** [Visible shell message](56-shell-message.png).

### B4 · P2 · Escape from a model dropdown also dismisses Settings

**Reproduction:** Open Settings → Models & accounts → Codex model; press Escape once.

**Observed:** Both the model dropdown and the entire Settings dialog close. Reproduced twice, without changing the selected model.

**Expected:** First Escape closes the dropdown and retains Settings; a subsequent Escape can close Settings.

**Impact:** Cancelling a selection unexpectedly exits the configuration workflow.

**Evidence:** [Dropdown open](54-model-dropdown.png), [after one Escape](55-dropdown-escape.png), [accessibility text](55-dropdown-escape.txt).

### B5 · P2 · Active tool tab disappears when the strip overflows

**Reproduction:** At the default tools-pane width of 520 logical pixels, open Context, CAD Viewer, Compute Jobs, a job detail, then Browser.

**Observed:** The Browser address bar appears, but the Browser tab is outside the visible strip. The screenshot shows Context, CAD Viewer, Compute Jobs, and the job tab followed by the fixed controls. The saved evidence does not establish the accessibility tab-selection state.

**Expected:** Selecting or opening a tool scrolls its tab into view. An overflow menu or visible scrolling affordance should expose hidden tabs and their close controls.

**Impact:** The pane's visible content and visible tab selection no longer agree.

**Evidence:** [Browser active with its tab hidden](50-settings-over-browser.png). Settings was open for this capture, but the tool strip is unobscured.

### B6 · P3 · Native app menu exposes the package name

**Reproduction:** Open the macOS Beam menu.

**Observed:** Menu items read `About @beam/desktop`, `Hide @beam/desktop`, and `Quit @beam/desktop`. The About dialog correctly identifies Beam 0.1.10.

**Expected:** User-facing native menu items consistently say Beam.

**Evidence:** [Native menu accessibility text](44-native-menu.txt), [About dialog](45-about.png).

## UX problems and improvements

| ID | Priority | What I disliked or found confusing | Improvement |
| --- | --- | --- | --- |
| U1 | P2 | ⌘K says “Jump to a chat…” and returns “Nothing matches” for a known chat in another visible workspace. Searching `just another` in supraluminal returns nothing; switching to testbed makes it find `just another test page`. | Label the current search scope. Prefer searching all accessible workspaces, grouping results by workspace, or offer an explicit scope switch. Current-workspace search may be intentional; the missing scope cue is the problem. |
| U2 | P2 | The simulation results rail puts runner selection and a long refinement summary before measurements and validation. On first opening the results, the relevant checks are below the visible rail. “Succeeded” and an attractive animation are easier to see than the limits of the result. | Put revision, selected result, solver status, conservation checks, and validation limitations at the top of Results. Keep mesh/refinement provenance in an expandable section. Existing validation copy is useful; make it easier to find. |
| U3 | P2 | New Compute Job initially offers `python3` with `["analysis.py"]` even though there are no input files. Entering invalid arguments shows the raw parser message `Unexpected token 'o', "not-json" is not valid JSON`. | Start with a runnable example or empty arguments with clear guidance. Show a friendly validation message next to Arguments. Warn when the suggested script has no corresponding input. Keep an advanced JSON editor, but consider an argument-per-row option. |
| U4 | P2 | Models & accounts says Claude Code needs ≥ 2.4, while Machines reports the installed 2.1.283 as signed in and ready. | Reconcile the documented minimum with capability detection. If installed versions differ from requirements, explain what works, what is unavailable, and the exact upgrade action. This pass did not verify whether 2.4 is truly required. |
| U5 | P3 | The same Codex selection appears as `GPT-6-Sol` in settings/sidebar, then `gpt-6-sol` in the mention picker and composer. | Use one display label throughout; keep provider IDs in an optional technical detail. |
| U6 | P3 | Simulation controls feel visually dense: all-caps labels, spaced monospace text, technical names, several stage buttons, and a long settings rail compete for attention. With chat beside it, even long study names truncate. | Strengthen hierarchy around the current task: study/result identity, primary action, view, then details. Reduce tracking on frequently scanned labels and expose full names on hover or expansion. Preserve the engineering information, but make scanning easier. |
| U7 | P2 | The existing `just another test page` history ends with an assistant header at 13:07 and no body or visible explanation. The earlier background-loop reply also promises a later report, but none is visible in the inspected history. | Show an explicit empty/interrupted/failed state when appropriate, with a route to run details. Investigate these stored runs before classifying a runtime bug. This is a presentation concern observed in old history, not a reproduced failure of a new agent run. |

Evidence: [U1 missing result](04-search-known-chat.png), [U1 found after switching workspace](06-search-testbed.png), [U2/U6 Results](01-results.png), [U3 validation](36-compute-invalid-args.png), [U4 Machines](12-machines.png), [U4 model requirements](14-models-visual.png), [U5 composer label](24-insert-mention.png), [U7 historical empty reply](56-shell-message.png).

## What worked

- Switching workspaces and restoring their chat tabs worked. The private-chat shortcut created a private chat and clearly identified its default agent.
- Mention insertion added `@codex` and updated the composer routing display.
- Context opened with chat/workspace scope controls and a useful empty state.
- The Tesla r7 results loaded; vorticity playback animated and Pause stopped it. The initial Setup view's “No computed field” changed to computed results after selecting Results, so that initial label was not classified as a loading defect.
- CAD Viewer loaded the built-in Flanged reducer sample. Front view, wire display, and measurement-mode activation changed state correctly. Dimensions and triangle count appeared. Point-to-point measurement accuracy was not tested.
- Compute Jobs rejected invalid JSON before creating a job. A real job on George's machine using `python3` and `["-c", "print('Beam QA: local smoke test')"]` progressed from running to succeeded, with the expected log text. The job detail returned correctly after chat navigation. [Completed job](40-compute-finished.png).
- The embedded Browser loaded `https://example.com/`. Opening Settings hid the embedded page beneath the overlay correctly.
- Machines, Usage & limits, and Notifications settings loaded. Usage included refresh age and reset timing.

## Scope and residual state

**Evidence correction, October 2, 2026:** The five accessibility text files named `21-modal-underlying-text.txt`, `40-compute-finished.txt`, `41-draft-before-switch.txt`, `42-shell-math-observation.txt`, and `43-draft-lost-repeat.txt` are byte-identical snapshots of unrelated Tesla simulation results. They are retained as original artifacts but excluded from this report's evidence. The affected findings use the corresponding screenshots; unsupported accessibility assertions have been removed. This correction does not constitute a new QA pass.

One new private `Untitled` chat was created in `testbed`. It contains the successful `QA local smoke test` compute-job card. No conversational agent prompt was sent. Draft probes were unsent and were lost during the reproduced navigation bug. The sample model and tool tabs were opened in that QA chat. No repo was attached to it.

This pass did not test sign-in, invitations/sharing, file upload, new agent execution/streaming, steering, approvals, interruption, git/PR landing, fresh meshing/solving, compute cancellation/failure recovery, offline transitions, notifications delivery, cross-device synchronization, or a second user's experience. The app remained online during the pass. No application source changes, commits, pushes, or deployments were made.

Recommended order: **B1 and B2**, then **B3/B4/B5**, then search scope and Results hierarchy. A follow-up QA pass should exercise a disposable agent task through approval, interrupt, resume, and failure recovery, plus a second client for shared state.

# Personal agent defaults and Jev evaluation

Model, reasoning effort and an optional connection choice belong to the signed-in person, keyed by harness. The workspace retains the shared @handle, permissions and context settings. Existing shared model settings remain the fallback until a person saves their own preference.

Every new dispatch, including automatic routing, resolves the message author's preferences and records the model ID, display label, effective effort and connected-account metadata on the run. The runner consumes that snapshot. Steers keep the active run's settings. Resume requires the same requester, runner, account email, model and effort; otherwise the next session receives the shared chat transcript without reusing the previous provider session. Legacy runs have no historical account/model snapshot and do not receive invented attribution.

The agent picker and composer show personal defaults. Agent response headers show only the snapshotted model and effort. Hovering or focusing those details opens an overlay with the requester, account and subscription. Codex model choices and supported efforts come from the selected runner's `model/list` probe. Unavailable models fail explicitly instead of being substituted. Refresh Connected harnesses after restarting the updated runner.

Connections default to the requester's own authenticated, online runner. Another member's pinned machine does not override this. Shared connections require the owner to enable sharing in Settings and the requester to select that connection in agent settings. Membership, sharing and availability are checked for each dispatch. The runner probes before starting the harness and refuses execution if the account metadata changed since dispatch.

## Jev

API contracts: [TypeSafe evaluation API](https://docs.typesafe.ai/api) and [Codex App Server model discovery](https://learn.chatgpt.com/docs/app-server).

Jev is experiment-only: explicit mentions and the existing production router are unchanged. `JEV_SHADOW=true` plus a server-side `JEV_API_KEY` enables independent shadow evaluations. `JEV_MODEL` defaults to `jev-latest`; `JEV_THRESHOLD` defaults to `0.9`. Both confidence and selected-option probability must meet that threshold. This is a conservative initial threshold, not a calibrated production recommendation.

Shadow evaluations receive the exact pre-dispatch context snapshot, log message ID, decision, model, probability, confidence and latency, and never call dispatch/apply. Router decisions include the same message ID for comparison. No conversation content or keys are logged by the Jev adapter. Provider failures/timeouts cannot dispatch work. The key supplied for this evaluation was used only in the benchmark process environment and was not saved in the repository or deployed.

Run synthetic benchmarks with credentials supplied in the process environment:

```sh
node scripts/jev-bench.mjs
node scripts/router-bench.mjs --hedged openai/gpt-5.4-mini
```

The latter requires `OPENROUTER_API_KEY` and reproduces the default one-second hedge to `google/gemini-3.5-flash-lite`. The fixture set is shared between benchmarks in `scripts/router-cases.mjs`.

## Local evaluation — September 20, 2026

One pass over 44 synthetic conversations; provider runs were sequential in time, so this is indicative rather than a controlled throughput comparison. Results include request/network time from this machine.

| Router | Correct | False activations | Missed requests | Median | P95 |
| --- | --- | --- | --- | --- | --- |
| Jev (`jev-1.13.0`), threshold 0.9 | 42/44 | 0 | 2 | 154 ms | 408 ms |
| GPT-5.4 mini + Flash Lite hedge | 44/44 | 0 | 0 | 1613 ms | 1754 ms |

Jev's unthresholded choices were correct on 43/44 cases. The threshold suppressed its raw false activation but also suppressed two real requests: “hmm what does the rate limiter do if redis is down” and a person answering an agent's question on behalf of another person. No Jev request failed in this pass. Do not promote it based on this small fixture set; collect more labeled ambiguous conversations and measure false activations separately from missed requests.

## Validation and rollout

Unit coverage checks author-specific preferences, immutable execution snapshots, sharing revocation, unavailable models/efforts, session isolation, uncertain classifications and invalid provider responses. A browser smoke check with mocked Convex data exercises the real settings and chat components, verifies personal-save arguments, and checks requester hover metadata. All workspace tests and type checks, Convex type checking and the web production build passed locally.

The backend was deployed on September 20, 2026, and the local development desktop app was started with the updated runner. The hosted web and packaged desktop releases have not been published. Keep Jev shadow disabled unless its server-side key and experiment flag are configured. No coding-provider credential is transferred between members.

## Shared installer — September 20, 2026

Beam 0.0.6 includes the compact model/effort header and the requester/account/subscription hover overlay. Hover, keyboard focus and Escape dismissal were checked in Chromium. The universal DMG supports arm64 and x86_64. Apple accepted the app submission `93298a1c-09af-4e49-a310-beca4cd3ccef` and DMG submission `3be47173-d831-4624-9224-bdccae96ede3`. Both have stapled tickets. The signed DMG was copied to the shared iCloud `supraluminal/Beam-0.0.6-universal.dmg` folder and its SHA-256 matched the source. No GitHub release or update feed was published.

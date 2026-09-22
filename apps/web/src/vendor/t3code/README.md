# T3 Code reuse

Source: https://github.com/pingdotgg/t3code, refreshed from `main` at **1de563c1** on 2026-09-21. MIT license retained in this directory and shipped at `/third-party/T3-CODE-LICENSE.txt`.

- `webviewCrashRecovery.ts` and its tests: `apps/web/src/browser/webviewCrashRecovery.*`; test import changed to Vitest.
- `hostedBrowserWebviewStyle.ts`: corresponding upstream browser helper; its rectangle type is local instead of importing T3's store.
- `previewUrl.ts`: URL normalization from `packages/shared/src/preview.ts`; plain errors replace Effect errors; Beam rejects credentials and control characters.
- `terminalLinks.ts`: URL-matching and delimiter handling from `apps/web/src/terminal-links.ts`; unused terminal-buffer and filesystem-resolution functionality excluded. Used by compute logs to open URLs in Browser.

`browser/BrowserHost.tsx` follows T3's separately hosted guest/pane presentation architecture. `BrowserStart.tsx` adapts the grouped discovery design from `PreviewEmptyState.tsx`. Desktop guest session guards are implemented for Beam's own bridge. `apps/runner/src/localServers.ts` adapts the listener parsing and bounded web verification approach from `apps/server/src/preview/PortScanner.ts`, with its own adjacent license.

Full T3 terminal integration is not copied wholesale: Ghostty's WASM renderer, native PTY service, terminal transport, font licenses, and packaged native dependencies form a separate integration. There is no interactive terminal in this change. The future PTY service belongs in the runner and must remain independent of durable compute jobs.

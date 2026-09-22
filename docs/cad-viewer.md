# CAD Viewer

Open **Tools → Engineering → CAD Viewer** beside a chat. The viewer supports STEP/STP, IGES/IGS, STL (binary or ASCII), and geometry-only OBJ. It is a viewer, not a parametric CAD editor. The CFD Editor remains a future tool.

## Opening models

- **Open model** or drop one file into the CAD pane for a local preview. Nothing is uploaded. **Attach to chat** explicitly uses Beam's existing draft upload flow and opens Context; send the draft to share it with the chat.
- Click a supported model attachment in chat or a model row in Context to open it in CAD Viewer.
- **From Context** offers This chat and Workspace sources. Previewing a workspace model does not include it in the agent's context; use Context's explicit inclusion action for that.
- Model outputs in Compute Jobs have **Open in CAD Viewer** next to the original download.
The tool opens directly into the viewport, drawn as a sheet: a flat ground, a quiet grid, the model's name and provenance in the bar above it, readouts in the corners (parts, triangles, section state), and a figure caption. There is no landing page or preloaded model; **sample** opens the built-in flanged reducer on demand. A rail on the right holds Parts (the square is visibility: click hides, ⌥click isolates), Section (off · x · y · z with a ruled slider and the cut position in model units), Bounds (the model, or the selected part with the model underneath), and Measure. The rail hides below 560 px of pane width and can be toggled from the toolbar. Loading and cancellation stay within the viewport.

Drag the divider to use all available pane width while leaving 480 px for chat. The limit follows the actual workspace size, including sidebar resizing or hiding; there is no percentage or 1,000 px cap.

The diagonal-arrow button in the tools header expands the viewer across the workspace. Click it again or press Escape to restore the chat split; the model, camera, and previous pane width are preserved.

Viewing controls include orbit, pan, zoom, fit/isometric/front/right/top views, shaded, edges (feature edges over the shading, 28° threshold) or wireframe display, grid, part selection, visibility, isolation, an X/Y/Z section plane, and **measure**: click two points on the model for the straight-line distance and its Δx/Δy/Δz, in the model's units, drawn as a tape on the model; Escape leaves the mode. Points land on the tessellated surface, so measurements are preview accuracy, not metrology. The visual cut is uncapped and does not modify the original model. Bounding dimensions describe the entire tessellated model, even when a part is hidden or isolated. These are preview bounds, not exact B-rep metrology. STEP/IGES output is converted to millimeters; STL/OBJ have no reliable declared length unit and are labeled **model units**.

The current limit is 20 MB per file, 2 million triangles, and 2,000 parts. Import times out after 90 seconds and can be cancelled. These are small-model preview limits, not an HPC-scale visualization pipeline. Large solver results need conversion/downsampling before viewing. The OBJ reader does not fetch external MTL files or textures. Proprietary native CAD formats and glTF are not supported in this slice.

## Architecture

`apps/web/src/cad/model.ts` defines a plain typed-array `CadModel` preview: named parts, vertex/normal/index buffers, optional part color, format and units. It has no Three.js objects, paths, process handles, or CAD sessions. A future remote conversion adapter can produce this same preview and keep the viewer intact. This is an internal rendering boundary, not yet a versioned remote artifact protocol.

The local adapter parses STL/OBJ with Three.js loaders and tessellates STEP/IGES with `occt-import-js` (OpenCascade/WASM) in a disposable worker. The worker transfers typed buffers and terminates on completion, cancellation, error, timeout, or unmount, releasing its WASM heap. Input geometry is checked before GPU allocation. File size and returned geometry limits do not provide a hard cap on transient kernel memory; exceptionally complex CAD can still exhaust browser resources.

The pane and renderer are lazy-loaded. OpenCascade itself is loaded only for STEP/IGES. Vite bundles the worker as an ES module and ships the WASM as a local asset, so no CDN or external model service is involved. No Electron/Node capabilities are exposed to the viewer. It works in the web app and Electron's sandboxed file-loaded renderer.

Artifact references store only file/source IDs or job/output IDs in personal pane state. URLs are resolved through existing authorized Convex queries on opening, and downloads are bounded and omit credentials. No new backend endpoints or storage tables are required. Current context/compute endpoints must already be deployed to open those artifact kinds.

The tab remains mounted across tool switches and pane hiding, preserving camera and visibility state. Closing the CAD tab or leaving its chat disposes the renderer. Shared artifact references can be reopened after restart; local unsaved previews and camera state are not persisted across app restart. Closing a viewer never cancels a compute job.

## CAD editing and OpenFOAM next

Keep authored CAD/case revisions and compute jobs outside this renderer. The next useful CFD slice is a case inspector/editor with mesh input selection and validated boundary/solver settings, followed by submission through the existing local executor. Batch mesh generation/solving belongs in durable compute jobs; an interactive CAD kernel session needs a separate lifecycle. Neither an OpenFOAM installation nor CAD modeling commands are installed by this change.

For remote execution, workers should publish original results plus bounded preview artifacts. The same chat/result references can open the preview while the durable job record retains the computation's provenance. Add remote conversion, chunked geometry, and field-data streaming independently of pane presentation.

## Dependencies and validation

Three.js 0.186.0 (MIT) provides rendering, controls, and mesh loaders. occt-import-js 0.0.23 (LGPL 2.1) embeds OpenCascade (LGPL 2.1 with its exception). Versions, upstream source revisions, license texts and rebuilding information are shipped in `public/third-party/CAD-NOTICES.txt` and adjacent notices. Preserve these assets and library source availability when distributing the desktop bundle.

Automated tests cover real STEP/IGES import with the installed kernel, known millimeter bounds, ASCII/binary STL, OBJ parts, unsupported/oversized/empty/corrupt geometry, non-finite coordinates/indices, bounded downloads, worker cancellation/timeout, and per-chat artifact routing. UI checks exercised the actual viewer through both development and production builds, including a sandboxed Electron window loading the production assets from disk. No test creates a real chat, uploads a real attachment, or submits a compute job.

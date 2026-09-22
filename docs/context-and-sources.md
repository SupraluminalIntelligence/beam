# Context and workspace sources

Context is the shared destination for a chat's documents, links, and notes. The chat-header Context button opens it directly; it is also available in the tools launcher. Existing persisted Files tabs now display Context.

Attaching, dropping, or pasting a file opens Context in **This chat**, before extraction/upload finishes. Transient upload rows show preparation, upload, and failure states. Uploaded drafts appear immediately to their author with a preview and Remove action. They are not available to other people or agents until sent. Composer thumbnails and sent attachments open the same pane preview. An empty file picker selection does not open a pane.

**This chat** contains sent attachments, the current person's drafts, and explicitly added link/note/file references. **Workspace** contains only explicitly shared sources; it does not aggregate private chats or automatically add every workspace document to every agent prompt. Both views are searchable. A source preview opens within the pane and returns to the same list/scope.

## Availability and use

- A file is uploaded once. Sharing creates a `contextSources` record referencing the existing file/blob. Including it in another chat creates a `chatContext` association, not another upload.
- Files must be sent before sharing. The Share action states that everyone in the workspace can view and reuse the source and requires an explicit click on Share with workspace. Sharing a document never grants access to its private origin chat or other attachments.
- New links and notes are included in the current chat immediately. They remain scoped to that chat until explicitly shared. Adding them does not itself dispatch an agent.
- Add to this chat associates a workspace source with the chat, idempotently. Workspace availability alone does not make it agent context. Remove detaches a source association; it does not delete the workspace source or erase information an agent already saw. Sent attachments remain part of the chat's message history.
- Link sources store a validated HTTP(S) URL and title. Beam does not silently fetch or ingest the web page. Notes are limited to 20,000 characters. Each chat can include 50 additional source associations. Existing attachment limits remain 10 files per message and 20 MB per file.
- The workspace library currently requires sharing from a chat; there is no separate upload-to-workspace flow or unshare/delete-library control in this first version. Source metadata is retained after a chat association is removed.

## Agent access

`files.forRun` includes explicitly associated workspace file references, after authenticating the runner/run and current dispatcher's chat membership. It never lists all workspace files. `contextForRun` returns only selected source associations. The runner provides `list_sources` and `read_source`, alongside `list_files` and `read_file`. New turns receive a bounded excerpt of notes and link references; full notes remain available through read_source. Context is labeled as source material, not instructions. Document access is revalidated before a cached local file is returned.

Adding or removing context affects later reads and subsequent turns; it does not rewrite an already submitted model prompt. Local files already read by an agent cannot be retroactively removed from that agent's memory.

## Rollout and verification

The additive `contextSources` and `chatContext` tables require deploying the Convex schema/functions before activating the new web bundle or restarting a runner with the new source tools. Existing attachments require no migration; they appear automatically in This chat. No existing file is shared automatically. This repo uses the same production Convex deployment for development and deployment, as documented in README.

Tests cover draft/private isolation, explicit sharing across private-chat boundaries, cross-workspace rejection, idempotent inclusion, reference reuse without another blob/file, agent inclusion/removal, URL/note validation, and membership revocation. An isolated browser fixture checks auto-opening during upload, draft preview, scope switching, workspace inclusion, sharing, and adding a link without touching real chats or backend storage.

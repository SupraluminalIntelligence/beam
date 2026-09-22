# Chat files

Use Attach, drag files into a chat, or paste copied files. Ordinary clipboard text stays text. File chips are drafts until the message is sent; a message may contain only files. Limits: 10 files per message, 20 MB per file. Drafts/abandoned uploads expire after 24 hours.

Sent files appear as cards and in the chat header's Files panel. The panel supports filename search, upload/agent-created attribution, date, and a link to the source message. Preview supports plain text, extracted DOCX text, PDF embedding, and common raster images. Other formats remain downloadable. Text previews truncate at 200,000 characters; original bytes remain downloadable. DOCX preview shows extracted text rather than Word layout. PDFs use the desktop/browser PDF viewer.

Convex stores originals and attachment metadata. Reads, uploads and sends require current chat membership, including private chat restrictions. Drafts are visible only to their uploader. Messages can only attach that author's unsent files from the same chat, with no duplicate IDs or reused storage records. Removing a draft deletes its blob; sent files cannot be deleted through that endpoint. Storage URLs are bearer download links and are only returned after authorization.

The runner downloads files attached to dispatch and steer messages into a separate temporary directory, providing paths (and extracted text paths when available). It does not automatically inject every earlier document's contents. Agents can use list_files and read_file to retrieve earlier attachments, and share_file to publish an explicit output file into the chat. share_file restricts files to the thread directory after resolving symlinks. Runner file access verifies the assigned runner and the dispatcher's current chat access.

Finder paste uses the native macOS clipboard file list through the preload bridge. The renderer cannot supply arbitrary paths. Browsers use ClipboardEvent files. Text-only clipboard contents remain text. Native clipboard support requires restarting the development app or installing a subsequent packaged release.

Validation: backend checks for membership/private chat, draft privacy/deletion, storage reuse, attachment ownership/chat scope and attachment-only messages; runner checks for safe materialization, size mismatch and symlink/path escapes; browser checks for previews, search, upload/remove, ordinary paste and Finder paste, including real DOCX extraction; isolated Electron check for native clipboard-to-preload file delivery. Browser fixtures and native test profiles do not write messages into real chats.

Implemented locally after 0.0.8; not included in the published 0.0.8 package.

# Notifications and typing

Notifications are stored in Convex for the requester and chat participants. Creating a chat, sending a message, or dispatching a run automatically follows it. **Mute chat / Unmute chat** lives in the chat menu; muting suppresses all new run alerts for that chat, including your own runs, and remains in effect when you participate again. Pending desktop banners also respect mute; existing inbox history remains. Global event preferences remain in Settings. Existing explicit follows are preserved; older chats subscribe as people next participate. Run execution on another person's machine does not change the recipient. Current workspace/private-chat access and personal notification preferences are checked before records are created, read, or claimed for desktop delivery.

The inbox retains records across reconnects and shows the latest 100. Native banners are claimed atomically by one connected desktop; they remain unread in the inbox until the chat is viewed or the notification is opened. Records older than ten minutes do not generate a reconnect storm of desktop banners. A failed or OS-suppressed banner still has its unread inbox record. The app never claims that macOS has actually shown a banner simply because it accepted the request.

- Completion: after the runner finishes landing/pushing its work.
- Failed/stopped: includes failed pushes and stale/offline runs.
- Needs input: approvals and questions; resolving the request or ending the run clears stale input alerts.
- Clicking a banner or inbox item opens the relevant chat without automatically scrolling.
- If that chat is already focused and visible, the notification is read quietly.

Settings includes completion/failure/input toggles, sound, and a local test notification. macOS controls whether Beam may display banners and sounds. Desktop delivery needs the updated app running. Closing its window hides it and preserves the authenticated listener and runner; choosing Quit stops them. Fully-quit push delivery and browser-native banners are not implemented; web users have the in-app inbox.

Typing activity is scoped to a chat and device session, authorized with the same chat-access check as messages. The client sends only an activity boolean and opaque session ID, throttled to roughly one update per two seconds. Draft text is never transmitted. Sending, clearing, blurring, leaving the chat or hiding the app stops the activity; a five-second expiry handles disconnects. Each viewer expires stale indicators locally even when no new server update arrives. Multiple devices belonging to one person appear as one name; users never see themselves in the indicator. The indicator reserves a line above the composer and lists one, two, or multiple people.

Validation: workspace tests/type checks and production web/runner/desktop builds; backend notification tests for recipient selection, retries, private access, preferences and resolved-input cleanup; typing tests for expiry/multiple devices; browser checks for multiple typists, expiration, inbox and duplicate desktop delivery. The signed 0.0.7 app accepted a native notification and emitted its `show` event. Closing its window left the hidden listener alive; the test used an isolated profile and runner directory.

The backend was deployed on September 20, 2026. Desktop changes and the auto-scroll removal are included in Beam 0.0.7.

The universal Beam 0.0.7 DMG was signed, accepted by Apple (submission `f3f851db-dc32-4e42-9ea6-451faad73e8a`), stapled, verified and copied to the shared iCloud supraluminal folder. The copied installer SHA-256 matches the source. No GitHub release/update feed was published.

## Scroll behavior correction (after 0.0.8)

Chat follows the natural bottom as streamed text and messages grow, without a prompt anchor or viewport-sized trailing spacer. Scrolling upward pauses following; returning to the bottom resumes it. Opening a chat starts at its newest content. A ResizeObserver tracks rendered content, including smooth text reveal and later layout changes. Reduced-motion preferences disable the animation. Browser checks passed for initial position, content growth, preserving a scrolled-up reader position, resuming follow, reduced motion and chat switches. This correction is not part of the already-published 0.0.8 installer.

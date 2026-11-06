# Reply to sender: unsent draft handoff

Selecting **Reply to sender** in the plain-text inbox reader creates a separate empty encrypted draft using the existing authenticated create endpoint. Sender and a single `Re:` subject prefix are then placed in the unsaved editor; the message field receives focus. The owner must write and explicitly save before the existing guarded send review becomes available. No send preparation, SMTP, IMAP or automatic save runs from Reply.

An unsaved draft, unconfirmed creation/save, or an open outgoing delivery review blocks the handoff and preserves the current editor. The recipient must be one canonical address; header controls, invalid/multiple recipients and oversized subjects are refused before any write. Subjects and bodies remain inert DOM text. The bounded incoming preview is deliberately not quoted as a complete message.

This targets the indexed **From** sender. Reply-To routing, In-Reply-To/References headers, threading, Reply All and attachments are not implemented by this increment. No schema or release-tooling changes. The approved inactive candidate remains pinned separately; this new source needs its own reviewed release before it is live.

Verification: integrated DOM tests cover save requirements, double clicks, dirty edits, unsafe headers, inert subjects, expired sessions and an open delivery review. The existing real Chromium scenario now enters the composer via Reply at 1440, 390 and 320 pixels, then exercises saved-draft review with synthetic providers, canceled confirmation, one synthetic SMTP transaction and owner/nonowner authorization. Synthetic provider results do not establish real email delivery.

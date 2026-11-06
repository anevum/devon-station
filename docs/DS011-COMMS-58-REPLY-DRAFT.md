# Reply and forward text: unsent draft handoff

Selecting **Reply to sender** in the plain-text inbox reader creates a separate empty encrypted draft using the existing authenticated create endpoint. Sender and a single `Re:` subject prefix are then placed in the unsaved editor; the message field receives focus. The owner must write and explicitly save before the existing guarded send review becomes available. No send preparation, SMTP, IMAP or automatic save runs from Reply.

An unsaved draft, unconfirmed creation/save, or an open outgoing delivery review blocks the handoff and preserves the current editor. The recipient must be one canonical address; header controls, invalid/multiple recipients and oversized subjects are refused before any write. Subjects and bodies remain inert DOM text. The bounded incoming preview is deliberately not quoted as a complete message.

This targets the indexed **From** sender. In-Reply-To/References headers, threading, Reply All and attachments remain unimplemented; Reply-To routing is described below. No schema or release-tooling changes. The approved inactive candidate remains pinned separately; this new source needs its own reviewed release before it is live.

Verification: integrated DOM tests cover save requirements, double clicks, dirty edits, unsafe headers, inert subjects, expired sessions and an open delivery review. The existing real Chromium scenario now enters the composer via Reply at 1440, 390 and 320 pixels, then exercises saved-draft review with synthetic providers, canceled confirmation, one synthetic SMTP transaction and owner/nonowner authorization. Synthetic provider results do not establish real email delivery.

## Forward text

**Forward text** creates another unsent draft, leaves recipients empty and focuses the To field. It includes an inert copy of the currently indexed text with original sender/date/subject, a forwarded-preview heading and an explicit warning that attachments are omitted. Existing shortened-message/attachment notices remain intact. It never fetches missing original content, copies attachment bytes, auto-saves the preview, or prepares/sends a delivery. `Fw:`/`Fwd:` subjects are preserved; a new `Fwd:` must fit the existing subject bound. The same dirty-edit, outstanding-create/save and pending-delivery-review guards apply to both actions. Invalid text/date/header inputs are refused before creating a draft.

Real browser coverage now creates and explicitly saves a synthetic forwarded-text draft before exercising the reply/send review path. Only the separate synthetic reply is submitted; forwarding itself opens no SMTP connection.

## Reply-To routing

Newly synchronized mail may carry one validated Reply-To mailbox inside the existing encrypted inbox payload. The reader displays it separately from From and labels the changed reply action. Reply uses that address; no-header and older cached messages retain the explicit Reply to sender action. Existing cache rows are not retroactively re-fetched, so older records without metadata must not be described as verified Reply-To routing. Header presence with an empty, invalid, grouped, repeated or multiple-address value is stored as an encrypted null sentinel: reading/forwarding still works, automatic reply prefilling is disabled, and the owner can enter a destination in a new draft. This is not proof of sender authenticity.

No schema migration or additional provider call is required. Reply metadata is authenticated with the existing owner/mailbox/UID encryption context; flags remain flags and no destination is added to cleartext database columns. The legacy unencrypted SQLite/D1 prototype adapters explicitly refuse snapshots containing Reply-To metadata before writes rather than silently losing it. Production mail already requires the encrypted D1 adapter. Old payloads without this field remain readable, and the existing offline recovery reader validates new payloads without changing the schema.

# DS011-COMMS-08 — Bounded single-part MIME text decoder

Status: **SOURCE-ONLY, SYNTHETIC, NOT CONNECTED OR DEPLOYED**. Stack on draft COMMS-07 PR #25 and preserve the upstream COMMS-06 through RB01 release gates.

## Scope

`src/communications/mail-mime-text.mjs` exports `decodeSinglePartPlainTextMime(Uint8Array)` and a generic, content-free error type. This is a pure, deterministic decoder for a narrow RFC 5322/2045/2047 subset. It takes a complete **already framed** raw MIME entity from trusted server-side code, then returns frozen `{ from, subject, text }` values. It does not fetch, authorize, classify, save, send, execute commands, or determine message UID/timestamp.

It accepts a maximum 64 KiB raw entity, 16 KiB of headers (up to 128 lines), at most 16 KiB decoded body bytes, a 512-character decoded subject, and 4,096 characters of decoded plain text. Headers require CRLF framing. Subject supports UTF-8/US-ASCII/ISO-8859-1 RFC 2047 B/Q encoded words and folded headers. Body supports 7bit/8bit, strict base64, and quoted-printable transfer decoding, with the same explicit charsets. Sender is reduced to one strictly parsed, lowercase ASCII email address; display name is discarded. Returned email headers remain **untrusted claims**, never authentication evidence.

Any multipart content, HTML, attachment/file disposition, unknown charset/encoding, malformed bytes/header, oversized payload, duplicate security-sensitive MIME header, embedded control character, or Unicode bidi override is rejected. Unsupported mail must remain visibly unsupported or quarantined; it must never be silently treated as validated plain text. No remote images, links, scripts, HTML rendering or automated agent actions are authorized by this parser.

## Tests

`tests/mail-mime-text.test.mjs`: 21 focused tests cover common encodings, source identity parsing, quoted-printable line wrapping, RFC 2047, header folding, malicious control characters, duplicate headers, unsupported HTML/multipart/attachments, invalid UTF-8, size limits, and compatibility with the existing read-only IMAP provider when a trusted synthetic connector calls the decoder. The focused suite and previous COMMS-04/05/06 source-only suites pass locally with Node 22, **60/60 tests**. Verify the exact PR-head GitHub Actions before using `SOURCE/CI VERIFIED` language.

## Boundary and next action

This does **not** implement a real TLS socket, IMAP tagged protocol and literal framing, bounded MIME stream acquisition, secrets, authentication/Access policies, live Purelymail login, real mailbox delivery, or a production D1 migration. It also does not fully parse MIME (multipart, attachments, or complex RFC 5322 address syntax remain intentionally unsupported). A future trusted provider connector must read exact literal octets with independent framing, size checks, verified TLS and properly scoped credentials, then invoke the decoder; a separate authenticated UI must render returned fields using text nodes, not HTML. Treat all incoming messages as untrusted even after parsing and never trigger privileged tasks or sends directly from their content.

**No-go until** named owner/nonowner authorization, secure credentials, real provider read-only connection, MIME fallback handling, disposable D1 and backup/restore, reviewed retention and signed send approvals, and production release authorization. This change does not touch DNS, email routing, D1, live mail, background scheduling, cloud spend, or deployment.

# CAL01 - First-party calendar and portability contract

Status: SOURCE-ONLY FOUNDATION. Issue: https://github.com/anevum/devon-station/issues/13 . This document is not a production migration, Access change, email change, database migration, deployment or provider cutover. DS011-RB01 acceptance gates still apply.

## Product experience

Build Today, Day, Week, Month and Agenda surfaces in the existing DevonStation application. Integrate the owner's personal schedule, family routines, writing, development and task/project reference links while preserving family-first priorities. An unfinished task, read-only project milestone and actual time appointment are different record types and must never be silently conflated.

Provide fast event creation, keyboard-accessible search, calendar filter chips, a contextual event editor, visible conflicts, focus windows, reminders, availability windows and source lineage. Support installed iPhone PWA safe areas, VoiceOver and high contrast, clear offline drafts, conflict prompts and reduced motion. Demonstration screens are synthetic until connected to authorized data.

Suggested user-visible filters are Family & Home, Personal Appointments, Cristy Operations, Writing, Development and ANEVUM. Filters DO NOT confer authorization. Business-owned calendars and personal calendars remain separate data owners. Patient/client information does not belong in DevonStation.

## Architecture

- First-party Worker and D1 eventually own authoritative events, not Google Calendar, Notion or local browser caches.
- Trusted backend identity and resource-level calendar memberships independently authorize reads, writes, imports, exports, search, reminders and invitation actions. Never trust browser-supplied principal, role or scope.
- R2 holds only explicitly authorized attachments or client-encrypted recovery packages, with independent off-provider recovery validation. GitHub stores public-safe AGPL source, never real events or patient/business records.
- RFC 5545 ICS import/export is required; iTIP invitations and CalDAV native iPhone synchronization are separate capabilities with independent interoperability tests. ICS read/export alone is not CalDAV.
- UTC instants plus IANA time zone for timed events; local date intervals with exclusive end dates for all-day events. Preserve wall-clock intent for future recurring-event DST semantics.
- Future normalized schema: calendars, calendar_memberships, calendar_events, calendar_recurrence, calendar_reminders, calendar_import_batches, calendar_change_receipts. Any D1 migration must be additive, reviewed, backed up and explicitly authorized.

## Source-only increment shipped by this branch

The strict parser/serializer in src/calendar-portable.mjs supports a canonical version-1 JSON envelope for a **single non-recurring event**. Required fields: version, id, calendarId, uid, title, kind, start, endExclusive, timeZone. Optional fields: status, notes. Timed start/end are canonical UTC ISO 8601 with millisecond precision; all-day values are local YYYY-MM-DD dates. End is always exclusive. Stable identifiers and valid IANA zones are required.

This is a data boundary, NOT a live calendar, real Google migration, recurrence expander, RFC 5545 importer, database write, authorization check or invitation service. Unknown fields, including recurrence, attendees, reminders and scopes, fail closed so that imports cannot silently lose these features. Backend access checks remain mandatory.

Current tests only exercise synthetic records. They cover timed and all-day round-trip, a daylight-saving boundary, invalid zones, ambiguous local/offset timestamps, nonexistent dates, reversed ranges, malformed inputs, unsupported versions and unknown fields.

## Migration design (no live operations in this branch)

1. Privately inventory source calendars, events, recurring series/exceptions, organizer/attendee ownership, time zones, any shared events and external invitations. Make and test a recoverable export before changing service access.
2. Preview validated staged ICS with KEEP / ARCHIVE / SKIP / NEEDS ATTENTION. Do not import unsupported objects or leak external participant details. Deduplicate by UID, sequence and original occurrence identity.
3. Import only explicitly approved records with idempotent receipts, server-enforced calendar scope and generation conflict checks. Compare source/target counts, times, DST behavior, recurrence and cancellations independently.
4. Test PWA offline draft recovery, reminders, attendance/invitation semantics, iPhone native compatibility if CalDAV is delivered, access denial, encrypted export and restore.
5. Keep Google read-only during a transition period; retire it only after the owner approves a verified no-loss cutover. Phone app removal is not provider migration.

## Email and identity dependency

Cloudflare Email Routing can forward/process incoming mail and Email Sending can deliver transactional messages; these alone do not supply a normal IMAP mailbox, message history/search and human reply workflow. A full mailbox provider or separately operated standards-based email server must be independently verified before abandoning Gmail. New custom-domain mail requires receiving, outgoing SMTP, SPF, DKIM, DMARC, mailbox export, recoverable MFA and a successful secondary identity check.

Never change existing Cloudflare Access owner allow lists or account recovery identity just because an untested new email address has been proposed.

## Release gates

This branch is source-only and based on the RB01 review tree. PR target must be the RB01 review branch, NOT the published main branch, until that base is accepted. No production deploy, DNS/MX edit, account deletion, billing change, Access change or database migration is in scope. Full CI and privacy checks, independent review, RB01 owner/nonowner/MFA/authentic-backup acceptance and separate import approval are required before any live cutover.

Future independently gated increments: RFC 5545/recurrence and staged validation; D1 calendar authorization; UI and CRUD; reminder/invitation receipts; CalDAV and actual iPhone sync; owner-approved event import and verified retirement of the Google source.

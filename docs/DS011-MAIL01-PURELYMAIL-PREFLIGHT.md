# DS011-MAIL01 - Purelymail onboarding and reusable mail-preflight source

Status (2026-11-02): SOURCE-ONLY, not activated or deployed. Does not add a real mailbox, configure Cloudflare DNS, install an IMAP/SMTP adapter, send email, or change any existing login identity.

## Ownership and scope

- Personal domain: `devonakins.com`; intended public address: `hello@devonakins.com`.
- Reusable mail-onboarding code: `src/communications/mail-onboarding.mjs` (provider settings, account-independent DNS proposal, DNS audit, activation gates).
- Mail remains a separately owned account and provider-managed service; DevonStation is a future interface, not the authoritative mail server.
- Each future client owns its domain, service account, credentials, deployment and data. Never pool credentials or mail content across clients.
- Existing owner Cloudflare Access and other login/recovery mail must remain operational during migration. Never rewrite existing access policies or delete Google/Hotmail accounts as part of this setup.

## Owner-controlled Purelymail account step

1. Visit https://purelymail.com/signup/ in your own browser. A free trial is available and requires mobile/SMS verification. Alternatively, there is a paid Simple plan (currently advertised at $10/year). Payment and accepting provider terms are owner actions.
2. Choose a unique account administrator identity, strong password, out-of-band recovery, and MFA. Keep passwords, recovery codes, app passwords and payment data out of this repository, chat and Notion.
3. In the Purelymail administrator portal, select Domains -> Add New Domain -> `devonakins.com`. Record the **account-specific TXT ownership proof** shown on that screen. It is a public DNS verification record, not an IMAP login secret; it must still be read from the actual provider page, not invented. Check whether other provider DNS values on that page differ from the published template; if so, use the live portal values.

## Read-only Cloudflare audit and planned records

The connected Cloudflare account was inspected on 2026-11-02. Active zone `devonakins.com` had only three proxied website/Brandicade AAAA records and no MX, SPF, DKIM or DMARC. Email Routing was disabled and unconfigured. **No records were changed.** The three existing AAAA records must remain as-is.

Once the owner has registered the domain at Purelymail and obtained the account-specific ownership record, the proposed DNS set is:

| Type | Name | Value | Options |
| --- | --- | --- | --- |
| MX | @ | mailserver.purelymail.com | priority 50, DNS only |
| TXT | @ | v=spf1 include:_spf.purelymail.com ~all | DNS only |
| TXT | @ | Purelymail-provided unique `purelymail_ownership_proof=...` | Copy exact live value |
| CNAME | purelymail1._domainkey | key1.dkimroot.purelymail.com | DNS only (unproxied) |
| CNAME | purelymail2._domainkey | key2.dkimroot.purelymail.com | DNS only (unproxied) |
| CNAME | purelymail3._domainkey | key3.dkimroot.purelymail.com | DNS only (unproxied) |
| CNAME | _dmarc | dmarcroot.purelymail.com | DNS only (unproxied) |

Use https://purelymail.com/docs/domainDocs and https://support.purelymail.com/support/solutions/articles/159000360245-how-to-set-up-your-custom-domain-dns-records as authoritative documentation; DNS data from the specific account dashboard overrides this template. Do not enable Cloudflare Email Routing for the same root-domain MX. Never remove/replace other provider records until a read-only conflict audit, owner confirmation and rollback plan.

Return to Purelymail -> Check DNS Records -> Save. Set Deliver Mail To = Purelymail. Create the `hello@devonakins.com` mailbox (real user, not merely an alias) and separately consider optional aliases later. Enable MFA and generate only the restricted per-application password needed for an authorized mail sync adapter. The admin account password should never be reused as an app password.

## Transport readiness, not implementation

- IMAP over TLS: `imap.purelymail.com:993`.
- SMTP over TLS: `smtp.purelymail.com:465`; STARTTLS alternative: 587.
- Full email address is the IMAP/SMTP username. Provider-side MFA requires an app password for protocol clients.
- The mail-onboarding profile intentionally contains no secrets and disables outbound sending until verification. The reusable transport adapter, authorized server-side secret handling, browser UI, synchronization, retention and approval workflow are later separately tested changes; passing DNS preflight is not a working email integration.
- Avoid long-lived IMAP IDLE connections in an ordinary short-lived Worker; test scheduled bounded sync or a maintained connector service before choosing the runtime. A webhook is not automatically available with every IMAP provider.
- The live product must enforce signed identity and per-mailbox authorization, sanitized MIME/HTML, attachment scanning, no remote tracking by default, rate limiting, least privilege, idempotency and human approval before sending. Inbound email is untrusted input even if the sender is recognized.

## Verification and release gates

1. Run `node --test tests/mail-onboarding.test.mjs`; the fixture intentionally uses fake domain ownership data.
2. Confirm account-specific Purelymail domain ownership TXT and all live DNS records (MX, SPF, DKIM, DMARC) with the Cloudflare provider API; audit foreign MX/SPF conflicts before changes. No DNS automation is enabled in this increment.
3. Verify the mailbox is saved in Purelymail; test receiving from a separate account, message reading, SMTP sending and receiving a reply. Inspect message authentication results and spam placement.
4. Independently test MFA/recovery and preserve existing Cloudflare Access owner identity plus old login inboxes until a verified safe migration.
5. Only after a safe app-password storage and tested mail adapter are in place should DevonStation expose real mail data. No clinical or client data in this pilot.

## Revert and escalation

Before changing DNS, export the exact existing records, confirm the domain's registered receiving provider, and obtain owner approval for the specific DNS set. For an unsuccessful onboarding, revert only newly added mail records, not website or unrelated AAAA records. Never delete the Purelymail mailbox as a rollback shortcut because doing so would lose mail. Email and account recovery paths remain separate from the public `hello@` mailbox.

Sources: https://purelymail.com/docs/users ; https://purelymail.com/docs/setup/technical ; https://purelymail.com/docs/domainDocs ; https://purelymail.com/pricing.

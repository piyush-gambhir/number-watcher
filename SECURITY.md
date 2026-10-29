# Security notes

## CodeQL URL comparison triage (2026-10-29)

The `messaging.twilio.com` substring in `test/providers.test.ts` selects a
mocked response in an offline test. It does not authorize a network request.

In `scripts/verify-live.ts`, provider requests first pass an exact `URL.origin`
allowlist and a GET-only check. The later `hostname.endsWith('twilio.com')`
expression only labels a report row. It is not the network security boundary.
These two `js/incomplete-url-substring-sanitization` findings are false positives
for authorization. Preserve the exact origin and method checks.

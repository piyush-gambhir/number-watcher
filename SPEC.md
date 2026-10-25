# Number Watcher specification

Version 0.3, October 26, 2026. The CLI, durable request queue, provider adapters, notification modules, and AWS Lambda/Terraform implementation are available. AWS deployment and live purchase/delivery acceptance remain operator steps.

## 1. Purpose and scope

Watch available phone numbers on selected providers and either acquire the requested quantity or notify when enough matching inventory is observed. Start with Twilio and Telnyx; keep provider-specific API behavior outside the shared job engine.

The application supports a TypeScript CLI with persistent local disk and an AWS Lambda runtime with DynamoDB checkpoints and per-request EventBridge Scheduler triggers. It supports US local numbers only. A dashboard, additional countries/number types, porting, creating voice or messaging applications, provider reservations, and continuous monitoring after fulfillment are deferred.

A job uses one account per selected provider. Numbers acquired from different providers stay with their respective providers. Each must have its own compatible voice/messaging integration; this tool does not translate provider webhook payloads or move numbers between providers.

## 2. Job fields

| Field | Required | Definition |
| --- | --- | --- |
| `version` | Yes | `1`, the configuration format version. |
| `name` | Yes | Human-readable job name, 1 to 80 characters. An immutable execution ID is generated separately. |
| `mode` | Yes | `notify` or `purchase`. No implicit purchase mode. |
| `country` | No | Defaults to `US`; other values are rejected in v1. |
| `numberType` | No | Defaults to `local`; other values are rejected in v1. |
| `areaCodes` | Yes | Nonempty ordered list of distinct three-digit strings matching `[2-9][0-9]{2}`. Syntax validation does not establish that an area code is assigned or has inventory. |
| `requiredCapabilities` | Yes | Nonempty unique list from `voice`, `sms`, `mms`. Every selected capability is required. In v1, `mms` also requires `sms` in this list. |
| `quantity` | Yes | Integer from 1 to 100. One shared target across all listed area codes and providers. |
| `providers` | Yes | Nonempty ordered list of distinct provider entries, initially `twilio` and/or `telnyx`. List order expresses preference. |
| `pollIntervalSeconds` | No | Defaults to 300; integer from 300 to 3600. |
| `durationHours` | No | Defaults to 24; positive integer, maximum 24. |
| `budget` | Purchase: yes | USD price limits described below. Optional in notify mode. |
| `notifications` | Notify: yes | A nonempty `channels` list selecting Slack, email, and/or signed generic webhooks. Optional in purchase mode. Channel IDs must be unique. Console output is always available. |

Area-code order takes precedence over provider order. For `areaCodes=[210,726]` and `providers=[twilio,telnyx]`, preference is Twilio 210, Telnyx 210, Twilio 726, Telnyx 726. This is preference among candidates returned in the current round, not a guarantee that an unavailable or failed preferred provider is searched successfully before fallback.

Unknown fields, duplicate providers/codes, invalid values, and missing conditional configuration are errors. Do not silently fix a typo or relax a requirement. Existing owned numbers do not fulfill a new acquisition job.

## 3. Matching and price limits

All requested filters use AND semantics, except area codes and providers, which are acceptable alternatives. Independently verify country, local type, exact area code, and advertised capabilities after normalizing each provider response. Disable Telnyx best-effort matches. Never substitute a nearby area code or silently drop an unsupported capability.

Candidates are deduplicated by normalized E.164 number across providers and area codes. Exclude numbers already owned by a selected account, already acquired by the job, or associated with its pending/uncertain intent. For the same number returned by both providers, retain the preferred provider for that round. Sort candidates by area-code preference, provider preference, then E.164 for reproducibility. Cheapest-first selection and per-area-code quotas are deferred.

| Budget field | Rule |
| --- | --- |
| `currency` | Required when a budget is supplied; `USD` only. No currency conversion. |
| `maxMonthlyPerNumber` | Required with a budget. Nonnegative decimal string with at most four decimal places. Mandatory in purchase mode. |
| `maxOneTimeFeePerNumber` | Optional nonnegative decimal string. Caps a separate setup/activation fee, excluding recurring rental even when its first month is billed immediately. |

Evaluate fresh account-specific pricing before each purchase, using exact decimal arithmetic. Unknown monthly price, incompatible currency, or an over-limit price makes a candidate ineligible when a budget is present. If a one-time fee cap is supplied and that fee cannot be established, the candidate is ineligible; missing fee data is not zero. Explain exclusions in status output.

Twilio's country/type pricing API provides account-specific monthly rental, rather than per-result pricing. Telnyx search results provide monthly and upfront cost information. Each adapter records source, timestamp, scope, and any unknown amounts. A separate setup fee must not be confused with the first monthly rental payment.

These are checks on available price quotes, not provider-enforced transaction limits. Quotes can change and do not cover taxes, usage, carrier fees, or future renewals. Report estimated rental commitments and acquisition fees separately. With quantity Q and monthly ceiling M, the planned maximum quoted monthly rental for this job is Q × M.

Sources: [Twilio pricing](https://www.twilio.com/docs/phone-numbers/pricing), [Twilio billing timing](https://help.twilio.com/articles/223182908), and [Telnyx search](https://developers.telnyx.com/docs/numbers/phone-numbers/number-search).

## 4. Purchase versus notify

### Purchase mode

Acquire matches as they appear. Quantity need not be simultaneously available. A job requesting three numbers may acquire one in each of three rounds, across either provider or area code.

Only one purchase/order may be in flight for the whole job. Persist an intent and reserve a quantity slot before submitting it. An accepted pending order, a confirmed owned number, or an unresolved purchase intent occupies a slot. Do not exceed quantity, including these occupied slots.

Finish activation and configuration for the current acquisition before purchasing the next number. An unresolved write, pending order, or configuration failure blocks further purchases on both providers. A definitive failed acquisition may release its slot only after reconciliation establishes no outstanding order or owned number. An ambiguous failure never releases it automatically.

The job succeeds when exactly quantity numbers are activated and their requested routing is verified. An acquired number with failed configuration still occupies a slot and is reported as partial progress; do not buy a replacement. Never release a number automatically.

### Notify mode

Make no provider mutations: no purchases, reservations, profile updates, or number configuration.

Quantity is an availability threshold. When one completed search round observes at least quantity distinct matching numbers, emit one `availability.found` event containing the first quantity candidates in preference order. Do not accumulate sightings from earlier rounds. Fewer matches are visible in status output but do not trigger this alert in v1.

Stop searching once this event is durably queued. The job succeeds after all configured channels acknowledge delivery. If delivery fails after the retry budget, exit with `needs_attention` and keep the event for explicit redelivery. Redelivery reports the original observation time; it does not claim the numbers remain available. An availability notification does not hold inventory or promise that a later manual purchase will succeed.

A notify job cannot become a purchase job through resume. Starting purchases requires a new explicit configuration and execution.

## 5. Provider configuration

Credentials are read from named environment variables and never copied into state or logs. Validate the exact account identity and all required permissions/resources before the polling window begins. Fail startup if a selected provider is misconfigured rather than silently dropping it.

### Twilio provider entry

- `type: twilio`.
- `accountSid`: required exact account/subaccount SID.
- `apiKeySidEnv`, `apiKeySecretEnv`: required environment-variable references.
- `purchase.voiceUrl`: required in purchase mode when voice is required. Existing HTTPS handler, `POST`.
- `purchase.smsUrl`: required in purchase mode when SMS/MMS is required. Existing HTTPS handler, `POST`.
- `purchase.messagingServiceSid`: required in purchase mode when SMS/MMS is required. Existing service in the target account.

Search `AvailablePhoneNumbers/US/Local` with the area code and all required capability filters. Purchase the exact E.164 number through `IncomingPhoneNumbers`, setting the relevant webhooks and a job-specific friendly name in the create request. Save the returned phone-number SID immediately. Add it to the selected Messaging Service when messaging is required, then read back configuration and membership.

Preflight must check service capacity and effective inbound routing. The service must either use the number's own SMS webhook or already have the requested SMS URL and POST method. Recheck after attachment. Do not modify shared service settings automatically. Voice-only jobs do not require SMS settings; messaging-only jobs do not require voice settings.

Sources: [search](https://www.twilio.com/docs/phone-numbers/api/availablephonenumberlocal-resource), [purchase/configuration](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource), [service membership](https://www.twilio.com/docs/messaging/api/phonenumber-resource), and [service routing](https://www.twilio.com/docs/messaging/api/service-resource).

### Telnyx provider entry

- `type: telnyx`.
- `apiKeyEnv`: required environment-variable reference. Validate access through the read-only balance API, and pin a SHA-256 fingerprint of the API key across restarts. This is credential continuity, not a verified Telnyx organization ID. A changed key is rejected on resume, including a rotated key for the same account.
- `purchase.connectionId`: required in purchase mode when voice is required. V1 supports an existing Call Control application/connection.
- `purchase.expectedVoiceWebhookUrl`: required with voice, to verify the existing application's handler.
- `purchase.messagingProfileId`: required in purchase mode when SMS/MMS is required. Existing enabled Messaging Profile.
- `purchase.expectedSmsWebhookUrl`: required with messaging, to verify the profile's existing handler.

Search `/v2/available_phone_numbers` with country, local type, `national_destination_code`, capabilities, and `best_effort=false`. Validate every returned match. Telnyx requires a recent search before an order, so refresh the candidate's availability if a saved candidate is being used after a delay/restart.

Order one exact number at a time through `/v2/number_orders`, including the applicable `connection_id`, `messaging_profile_id`, and job-specific `customer_reference`. Save the order ID immediately. A successful HTTP response means an order exists, not necessarily that activation finished. Poll its status every 30 seconds in the local runner or on the next scheduled cloud invocation. Pending regulatory/setup requirements must be reported explicitly.

Verify the activated number's connection/profile assignments and the effective application/profile webhook URLs. These resources are pre-existing and are not rewritten by the tool. Provider-native handlers must already work; a Twilio handler URL is not presumed compatible with Telnyx.

Sources: [search](https://developers.telnyx.com/docs/numbers/phone-numbers/number-search), [create order](https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order), [order lifecycle](https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders), and [webhook routing](https://support-v2.telnyx.com/en/articles/4334722-how-to-leverage-webhooks).

## 6. Scheduling and recovery

Search immediately after preflight, then on fixed interval slots strictly before the absolute deadline. Store original start/deadline and never extend them on restart. Skip missed slots and do not overlap rounds. Search requests across providers may run concurrently; all writes stay serialized. A partial search failure must appear in the round result, not as zero inventory.

Search enough bounded results to fill the remaining purchase slots, or the notify threshold. At the defaults, a 24-hour job has 288 scheduled rounds. Two providers and two area codes produce at most 1,152 scheduled search requests before retries, pagination, pricing lookups, preflight, and order-status checks.

Recheck cancellation, remaining quantity, deadline, and price immediately before every new purchase. After the acquisition deadline, do not start another purchase. An in-flight request can resolve after that time and must still be recorded. Allow ten minutes after the deadline for activation/configuration/reconciliation and final-event delivery, then exit with an actionable result if work remains unresolved. Never interpret an uncompleted order as a failed acquisition or cancel it automatically at expiry.

| Condition | Policy |
| --- | --- |
| Empty inventory or below notify threshold | Continue on schedule until deadline. |
| Explicit candidate-unavailable rejection | Record it and try another candidate within the deadline. |
| Search timeout, rate limit, or transient server error | Bounded provider-aware backoff with jitter; continue healthy providers and mark the round degraded. |
| Runtime authentication/permission failure | Disable the affected provider and emit one degradation event. Continue healthy providers if there is no unresolved acquisition; fail if none remain. |
| Purchase timeout, dropped connection, or ambiguous server error | Pause all acquisition and reconcile the exact candidate, ownership, and order/job reference. Never blindly retry or switch providers. |
| Reconciliation still uncertain after three bounded attempts | Persist `needs_attention`, notify if configured, and exit. A missing ownership result alone does not prove failure. |
| Pending Telnyx order | Keep its slot occupied, monitor it, and do not order another number. |
| Configuration failure after ownership | Retry configuration only, at most three bounded attempts, then exit with `needs_attention`. Keep its slot occupied. |
| Interrupt/cancellation | Stop starting new work, preserve state, finish recording any in-flight result, and report outstanding orders. Resume reconciles before proceeding. |
| Changed saved config or another active worker | Reject invocation; do not reset or replace the job. |

SDK-level automatic write retries must be disabled. Retry only when the adapter can establish the provider did not process the write; otherwise reconcile. For Twilio, HTTP 429 is documented as unprocessed and safe to retry after backoff. Do not assume the same guarantee for every provider/status code. Sources: [Twilio 429](https://www.twilio.com/docs/api/errors/20429) and [Twilio unavailable number](https://www.twilio.com/docs/api/errors/21422).

## 7. Notifications

Notification delivery is a module independent of phone-number providers. Configure one or more channels, each with a unique `id` and `type`. Every event has an independent persisted delivery record for each channel. Notify mode requires at least one channel; purchase mode may use console output alone.

| Channel | Configuration | Delivery |
| --- | --- | --- |
| `slack` | `id`, `webhookUrlEnv` | Slack incoming webhook with a readable text payload. The URL remains in an environment variable. |
| `email` | `id`, `fromEnv`, `toEnv`, optional `provider` | Provider-independent email module with SMTP and Resend implementations. `provider` defaults to `auto`. Explicit `from`/`to` may replace the corresponding environment reference. |
| `webhook` | `id`, `webhookUrlEnv`, `webhookSecretEnv` | JSON event with HMAC-SHA256 signature and timestamp. |

For email, explicit `provider=smtp` uses `SMTP_URL`; `provider=resend` uses `RESEND_API_KEY`. `auto` first honors `NUMBER_WATCHER_EMAIL_PROVIDER`, otherwise chooses Resend if its key exists, then SMTP. An unfinished delivery is pinned to its originally selected transport. Do not fall back to another email provider after a send failure, since the first provider may already have accepted the email. Adding another email provider requires implementing the `EmailProvider` interface and extending the module's selector, without changes to acquisition code.

SMTP requires TLS or STARTTLS; its URL must not contain arbitrary query options. Resend uses the event/channel ID as an idempotency key. SMTP uses a stable Message-ID. Resend's idempotency window is 24 hours; SMTP and Slack do not provide exactly-once delivery here. A lost acknowledgement can produce a duplicate notification. Successful channels are not resent when retrying failures.

Configuration contains environment-variable names rather than credentials. Resolved notification destinations, email-provider credentials, and webhook signing secrets are not persisted or logged. The examples use `NUMBER_WATCHER_EMAIL_FROM` for the sender and `NUMBER_WATCHER_EMAIL_TO` for comma-separated recipients. Resolve and validate these before polling. Require exactly one of `from`/`fromEnv` and exactly one of `to`/`toEnv`. Explicit sender/recipient addresses are part of the saved request; environment-resolved addresses are not. Provider voice/SMS webhook handlers are separate from these notification channels.

Events: `availability.found`, `number.pending`, `number.acquired`, `job.completed`, `job.expired`, `job.failed`, `job.needs_attention`, `job.cancelled`, and `provider.degraded`. Define `number.pending` as an accepted order awaiting activation, and `number.acquired` as activated and configuration-verified, not merely ordered. All events include a unique stable event ID, job ID, UTC occurrence time, mode, and progress counts. Availability events include observation time and normalized candidates. Acquisition events include provider, E.164, resource/order IDs, routing verification, and known quoted costs. Final events include acquired, pending, uncertain, configured, and remaining counts with explicit errors; pending/uncertain/configuration-failed numbers must not disappear from the result.

Persist events in a local outbox before delivery. HTTP channels use a ten-second request timeout and accept 2xx as acknowledgement. SMTP uses ten-second connection/greeting/socket timeouts and requires acceptance of every recipient. Make up to three attempts with delays of 0, 5, and 30 seconds, respecting available run time. Delivery is at least once; retries retain the event ID. Sign `timestamp + "." + rawBody` with HMAC-SHA256, using `X-Number-Watcher-Timestamp` and `X-Number-Watcher-Signature` headers. Receivers verify freshness/signature and deduplicate by event ID.

Acknowledgement from every configured availability-alert channel gates notify success. Purchase results remain recorded regardless of notification failure, and failed notifications never trigger replacement purchases. Expose execution status and notification delivery status separately; a successful acquisition with an undelivered final event is not reported as a failed acquisition.

## 8. State and CLI

Use a persistent state directory with an exclusive single-worker lock, atomically replaced JSON job state, and a durable notification outbox. V1 uses one active job across all providers on the host. All commands accept `--state-dir`, defaulting to `.state` in the working directory. All invocations must use the same state root; separate machines/state roots are outside the coordination guarantee. Refuse a new job while an earlier job in that state root has an unresolved external write or pending order; reconcile the earlier job first. Persist an intent before each mutation and provider IDs immediately afterward. If persistence fails, stop new writes and reconcile on recovery.

Persist resolved non-secret configuration and its fingerprint, provider account identities, execution ID, timestamps, round results, per-number intents/statuses, price snapshots, provider resource/order IDs, errors, and outbox records. Credentials and resolved notification secrets/destinations stay out of state. Resume requires the referenced environment variables. Verify the recorded Twilio account SID and Telnyx credential fingerprint before continuing. Never delete or overwrite a prior job to start another.

Job statuses: `queued`, `running`, `succeeded`, `expired`, `cancelled`, `failed`, `needs_attention`. Progress phase is separately `preflight`, `searching`, `ordering`, `waiting_activation`, `configuring`, `reconciling`, or `notifying`. Per-number records retain pending/owned/configured/uncertain state. `expired` may contain partially fulfilled quantity; `needs_attention` takes precedence when an external write remains uncertain or an accepted order remains pending at shutdown.

Available commands:

```text
number-watcher check --config request.json --offline
number-watcher check --config request.json
number-watcher add --config request.json
number-watcher start --config request.json
number-watcher worker
number-watcher worker --once
number-watcher run --job <id>
number-watcher resume --job <id>
number-watcher list
number-watcher status --job <id>
number-watcher cancel --job <id>
number-watcher retry-notifications --job <id>
```

`add` validates and queues a request without provider/network calls or notifications. Durations begin after execution preflight, not when a request is added. The worker processes requests in FIFO order, one at a time; `--once` drains the current queue and exits. A restarted worker resumes a saved `running` job before queued jobs. `needs_attention` jobs require explicit resume and block other jobs if an external acquisition remains unresolved.

`check --offline` only validates JSON. Normal `check` validates notification settings/environment variables and performs live read-only provider searches/resource/pricing checks; it sends no notifications and makes no provider mutations. SMTP connectivity and actual email delivery are not tested by this command.

`start` adds and immediately runs a new request. `mode=purchase` plus `start`, or queuing that explicit mode for a worker, authorizes the configured quantity without interactive prompts. `run`/`resume` execute the saved request, reconciling unfinished writes first and preserving its original deadline. Failed preflight can be repaired and explicitly resumed. Successful, expired, and fully cancelled jobs never reacquire numbers on resume.

`cancel` writes a durable cancellation request. SIGINT/SIGTERM also request graceful cancellation. An unstarted cancelled job can be processed without provider or notification credentials; its cancellation event remains in the outbox for later delivery. `retry-notifications` only drains saved events and never runs acquisition. Starting a genuinely new acquisition requires a new `add` or `start` execution.

Commands return JSON on stdout and progress on stderr. Run/resume exit codes are 0 for success, 2 for failure/attention, 3 for expiry, and 4 for cancellation; command/configuration errors use 1. Never conflate a degraded search with no inventory, an accepted order with a usable number, or failed notification delivery with failed acquisition.

## 9. Provider extension boundary

Use a small internal adapter registry keyed by provider type, not a public plugin system. Each adapter implements configuration/preflight validation, normalized search, price lookup, one-number acquisition, reconciliation, and configuration verification/repair. Shared code owns scheduling, global quantity slots, preferences, cancellation, state, and notifications.

Normalized acquisition outcomes must distinguish `owned`, `pending`, `rejected`, and `unknown` and retain provider IDs and diagnostics. An adapter must declare unsupported filters/configuration and fail validation rather than approximate them. New providers need an adapter, provider config validation, and the same behavior-contract tests. Provider-specific API objects do not escape into shared matching/accounting logic.

## 10. Acceptance criteria

Use fake time and mocked provider APIs for focused tests:

1. Invalid/missing area codes, quantity, capabilities, credentials, conditional routing, budgets, or notify destination fail before any purchase.
2. Voice-only, messaging-only, and combined capability requests require/configure only their applicable routes; extra capabilities are allowed.
3. Both adapters reject wrong-area-code, missing-capability, duplicate, over-budget, and unsupported-type results, including Telnyx best-effort results.
4. Selection follows area-code then provider preference. A provider outage is visible and does not prevent healthy-provider searches when no acquisition is unresolved.
5. A purchase target of three can fill as one Twilio number and two Telnyx numbers without exceeding three occupied slots.
6. Notify quantity three does not alert for two current matches or for three sightings spread across separate rounds. Three distinct current matches produce one durable event; duplicate E.164 numbers across providers count once.
7. Notify and check issue zero provider mutations; check sends zero notifications. Price limits use exact decimals, including boundary equality and unknown-price handling.
8. Immediate polling, interval slots, downtime/restart, cancellation, and the original expiry behave exactly as specified. No purchase starts after the deadline.
9. A crash before submission, after provider acceptance, before SID/order persistence, or during configuration cannot cause a duplicate acquisition on resume.
10. Pending Telnyx orders and ambiguous outcomes on either provider block new purchases across both. Explicit failures release slots only when reconciliation permits it.
11. Purchased-but-unconfigured numbers remain counted, visible, and retained. Resume repairs configuration without replacing them.
12. Webhook retries retain event IDs/signatures, preserve observation time, and expose failed delivery separately. Restart cannot resend a completed availability event with a new ID or trigger another purchase.
13. A second worker, modified config, persistence failure, completed-job resume, and original-deadline expiry cannot reset progress or start another acquisition.

Run typecheck, lint, and focused tests before building or shipping changes. Live end-to-end validation is separate from this planning task: begin with read-only checks, then a specifically configured real acquisition when requested. An actual inbound call and SMS validate handlers; API read-back alone validates only configuration. Outbound messaging readiness and regulatory registration are not promised by number acquisition.

## 11. Runtime limits

- Local CLI: one active request on a single host with persistent disk. Queued requests run sequentially. Cloud: independent requests use per-job DynamoDB leases and checkpoints. There is no web UI or public HTTP API.
- US local numbers; quantity shared across all selected area codes/providers.
- Notify mode uses a same-round threshold, sends one availability event, then stops.
- Twilio service preflight enforces the default 400-number capacity; custom larger limits are not detected.
- Twilio's separate setup fee is unknown in the current adapter. A configured one-time-fee ceiling therefore excludes its candidates instead of assuming zero.
- Telnyx supports existing Call Control applications and Messaging Profiles. Their shared settings are verified, not rewritten. Assignment mismatch after activation requires attention.
- Failed purchases or notifications do not trigger automatic number releases, provider failover for uncertain writes, or email failover.

Example requests use area codes 210/726 and quantity two as placeholders. Copy and edit them for an actual request. See README.md for setup, queue operation, notification selection, and recovery.

## 12. AWS runtime

The [Terraform guide](infra/terraform/README.md) defines setup, commands, costs, and deployment limits. The cloud runtime runs one bounded round per invocation, with no sleeping between polls. It uses Node.js 24, a 120-second timeout, a 180-second conditional lease, transactional revision checks, and compressed DynamoDB checkpoints. Only lease records have TTL; job records persist.

Cloud `submit` takes a caller-generated UUID and the same immutable configuration. Repeated submission of that UUID is idempotent and cannot reset progress; a different configuration for that UUID is rejected. A new UUID authorizes a separate quantity. Duration starts at durable creation, before remote preflight. A recovery schedule must exist before any provider purchase. AWS intervals must be whole minutes, from five to 60 minutes. Scheduler uses approximate minute-level timing.

Cloud commands are `submit`, `status`, `poll`, `cancel`, `resume`, and `retry-notifications`, invoked through IAM-authorized Lambda calls. Status is by job ID. Local and cloud state are separate. Uncertain purchases block further acquisitions in that job; separately submitted jobs are independent. Every new invocation reconciles saved unfinished acquisitions before another purchase. Completed jobs do not purchase again.

Cloud recovery and email/Slack retries continue across invocations. Each notification delivery pass attempts a channel once with at most three automatic attempts total, rather than sleeping for local retry delays. Purchase status and delivery acknowledgement are separate. Schedules are removed when terminal and all deliveries are acknowledged or exhausted, with a hard end date for recovery/delivery grace. Pending orders still unresolved ten minutes after the purchase deadline become `needs_attention` when next checked. Never release their quantity slots automatically.

Terraform supplies secret ARNs, permissions, logs, failure queue, and a queue alarm. Secret values are populated separately in Secrets Manager and never enter Terraform state. No AWS deployment, live IAM validation, actual number purchase/configuration, or external Slack/email delivery is claimed by mock verification.

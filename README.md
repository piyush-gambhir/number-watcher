# Number Watcher

A CLI and background worker that watches US local phone-number inventory on Twilio and Telnyx, then buys matching numbers or notifies you through Slack, email, or a signed webhook. No UI.

The application stays on TypeScript and Node.js. Direct dependencies use exact versions, and `package-lock.json` records the resolved dependency tree for `npm ci`. Dependencies were checked against npm's latest stable releases on October 25, 2026. TypeScript remains at 6.0.3 because the latest `typescript-eslint` release supports TypeScript below 6.1; TypeScript 7 requires a compatible lint-tooling release before upgrading.

Requests specify area codes, required capabilities, quantity, provider preference, duration, and an explicit `notify` or `purchase` mode. Quantity is shared across providers and area codes. The default interval is five minutes, for up to 24 hours.

## Setup

Use Node 24 LTS, Node 22.13+, or Node 26+. Install dependencies and build:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
cp .env.example .env
```

Populate `.env` locally with the credentials for the providers and notification channels you use. Credentials and notification URLs are referenced by environment-variable name in requests. No account, Slack app, email account, Messaging Service, or voice application is provisioned by this project.

## Add a request

Copy [the notify example](examples/notify.json) or [the purchase example](examples/purchase.json) into your ignored `requests/` directory and edit it:

```sh
mkdir -p requests
cp examples/notify.json requests/san-antonio.json
```

Set the request name, area codes, required capabilities, quantity, and selected providers. Replace the example account SID. Remove provider entries you will not use. The examples enable both Slack and email, with delivery settings and email addresses supplied through environment variables. Remove an unwanted channel if needed. The sample price ceiling is illustrative, not a current quote.

Validate JSON without credentials or network access, then queue it:

```sh
node dist/cli.js check --config requests/san-antonio.json --offline
node dist/cli.js add --config requests/san-antonio.json
node dist/cli.js list
```

`add` returns a job ID and saves an immutable request in `.state`. It contacts no providers and sends no messages. You can add requests from another terminal while a worker is running. Editing the source JSON after adding a request does not change the saved execution.

For a read-only provider preflight and inventory check:

```sh
node dist/cli.js --env-file .env check --config requests/san-antonio.json
```

This makes real read-only provider calls, but does not buy numbers, reserve them, change routing, or send test notifications.

## Run requests

Run one saved request, or keep a worker processing the queue:

```sh
node dist/cli.js --env-file .env run --job <job-id>
node dist/cli.js --env-file .env worker
```

The worker processes one request at a time, in order, and waits for newly added requests. `worker --once` drains the available queue and exits. Each request's polling duration starts after its execution preflight. To add and run a request immediately, use `start --config <path>`. Scheduling currently means the polling interval and absolute expiry; future start times and calendar/cron schedules are not implemented.

Keep the machine awake and run the worker under your existing process supervisor for unattended operation. All commands must use the same persistent state directory. Use `--state-dir /absolute/path` if starting commands from different working directories. Multiple machines or independent state roots are not coordinated.

## Purchases

Copy the purchase example and set `mode` to `purchase`. In addition to search settings, provide:

- A monthly USD price ceiling per number. An optional separate one-time-fee ceiling rejects candidates whose fee cannot be established.
- Twilio: exact account/subaccount, existing voice/SMS webhook URLs, and an existing Messaging Service when messaging is required.
- Telnyx: existing Call Control application/connection and Messaging Profile, plus their expected webhook URLs.

Only routes for required capabilities are mandatory. Existing handlers must support their respective providers. The tool verifies shared service/application/profile settings and does not rewrite them.

After a read-only check, queue the request and run the worker, or start it directly:

```sh
node dist/cli.js --env-file .env check --config requests/purchase.json
node dist/cli.js --env-file .env start --config requests/purchase.json
```

Executing or queuing a request with `mode=purchase` authorizes that quantity within its configured quoted price limits. No prompt is shown when inventory appears. It buys incrementally and stops at the requested quantity. Prices are quote checks and exclude taxes, usage, and future renewals.

A pending Telnyx order occupies a quantity slot. An uncertain purchase on either provider blocks all new purchases until reconciled. Acquired numbers with configuration failures remain counted and are never replaced or released automatically.

## Slack and email

Notifications are a module independent of phone-number acquisition. Each event has a saved delivery record per channel, so a failed email does not resend an acknowledged Slack message.

For Slack, create or reuse an incoming webhook for the desired channel, then set `NUMBER_WATCHER_SLACK_WEBHOOK_URL`. Requests refer to it:

```json
{"id":"operations-slack","type":"slack","webhookUrlEnv":"NUMBER_WATCHER_SLACK_WEBHOOK_URL"}
```

See [Slack's incoming webhook setup](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/). No Slack bot commands or interactive purchase buttons are needed.

The examples configure email using sender/recipient environment-variable references and an optional provider:

```json
{"id":"operations-email","type":"email","provider":"auto","fromEnv":"NUMBER_WATCHER_EMAIL_FROM","toEnv":"NUMBER_WATCHER_EMAIL_TO"}
```

With either supplied request example, Slack and email setup only requires environment variables:

```dotenv
NUMBER_WATCHER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your/webhook/path
NUMBER_WATCHER_EMAIL_PROVIDER=resend
NUMBER_WATCHER_EMAIL_FROM=numbers@your-domain.com
NUMBER_WATCHER_EMAIL_TO=you@your-domain.com,team@your-domain.com
RESEND_API_KEY=your-resend-api-key
```

For SMTP, set `NUMBER_WATCHER_EMAIL_PROVIDER=smtp` and `SMTP_URL` instead of `RESEND_API_KEY`. No application-code changes are needed. Sender/recipient addresses are validated before polling begins. Requests may also use explicit `from` and `to` addresses instead of `fromEnv` and `toEnv`, but cannot specify both forms for the same field. The sender must already be authorized by the email provider. Actual external delivery still needs a live test using a dedicated destination.

The email module selects the provider:

1. An explicit request `provider` of `smtp` or `resend` wins.
2. With `auto`, `NUMBER_WATCHER_EMAIL_PROVIDER` can select `smtp` or `resend` centrally.
3. Otherwise, use Resend when `RESEND_API_KEY` is set, then SMTP when `SMTP_URL` is set. Fail preflight if neither is available.

For SMTP, use a TLS URL such as `smtps://user:password@smtp.example.com:465`, or `smtp://user:password@smtp.example.com:587` with required STARTTLS. URL-encode special characters in credentials. For Resend, use an existing API key and an authorized sender/domain. Provider setup and deliverability remain with your existing email service.

There is no automatic email-provider failover after a send, because an error can occur after the provider accepts the message. SMTP and Resend implement the same [EmailProvider interface](src/notifications/email.ts); adding another provider does not require changing acquisition logic. See [SMTP transport](https://nodemailer.com/smtp) and [Resend's API](https://resend.com/docs/api-reference/emails/send-email).

Optional signed generic webhooks use this channel configuration:

```json
{"id":"automation","type":"webhook","webhookUrlEnv":"NUMBER_WATCHER_WEBHOOK_URL","webhookSecretEnv":"NUMBER_WATCHER_WEBHOOK_SECRET"}
```

The signature is hex HMAC-SHA256 over `timestamp + "." + rawBody`, with `X-Number-Watcher-Timestamp` and `X-Number-Watcher-Signature` headers. Receivers should verify freshness and deduplicate by event ID.

Availability alerts include numbers, providers, known monthly prices, and observation time. Purchase alerts distinguish configured numbers from pending/uncertain orders. Events also report completion, expiry, cancellation, failures, and disabled providers. Delivery uses bounded retries and is at least once: a lost acknowledgement can cause a duplicate. An availability alert does not reserve inventory.

## Inspect, cancel, and recover

```sh
node dist/cli.js list
node dist/cli.js status --job <job-id>
node dist/cli.js cancel --job <job-id>
node dist/cli.js --env-file .env resume --job <job-id>
node dist/cli.js --env-file .env retry-notifications --job <job-id>
```

Cancellation stops new purchases and preserves any in-flight order or owned number. SIGINT/SIGTERM also stop the worker gracefully. Expiry never releases numbers or cancels provider orders.

Resume retains the original deadline and quantity and reconciles unfinished writes before doing anything new. Successful, expired, and fully cancelled jobs do not purchase again. Failed preflight can be fixed and explicitly resumed. A job with an unresolved order blocks later requests until reconciled.

Telnyx credential continuity is enforced by a stored hash of its API key, not an organization-ID lookup. Changing or rotating that key during a job is rejected on resume; restore the original credential to reconcile the saved execution. Twilio checks its recorded account SID.

`retry-notifications` sends only outstanding deliveries. It never reruns search or purchase logic. Purchase success remains success when Slack/email delivery fails; inspect outbox delivery status separately. Notify success requires acknowledgement from all configured channels. Read-only checks validate notification configuration but do not verify real email or Slack delivery.

State contains request settings, phone numbers, order IDs, and delivery history. Explicit email addresses supplied in requests are saved; environment-resolved email addresses are not. Credentials, resolved notification URLs, and signing secrets are excluded. Keep `.state` private and persistent.

## Development and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests cover filtering, price limits, both providers' HTTP contracts, lost purchase responses, cross-provider quantity, pending orders, durable intent, cancellation, restarts, notification retries, SMTP/Resend selection, and mocked end-to-end acquisition. Development verification uses fake credentials and mocked transport responses. Real purchases and notification delivery have not been exercised.

A read-only Twilio check has also passed against a real account: authentication, owned-number inventory, exact-area-code search, price lookup, durable notify execution, signed local notification capture, and completed-job resume. It caught a REST capability-key mismatch (`SMS`/`MMS` versus lowercase keys), now covered by a regression test. Telnyx live behavior, external Slack/email delivery, and actual number purchase/configuration remain unverified.

To repeat live read-only verification with an explicit credential file:

```sh
npm run test:live -- --env-file /path/to/uat.env --providers twilio --area-codes 210,726
```

Use `--providers twilio,telnyx` to check both. Twilio accepts `TWILIO_ACCOUNT_SID` with either `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET` or `TWILIO_AUTH_TOKEN`. Telnyx requires `TELNYX_API_KEY`. Credentials are read in memory and never copied to the project. The verifier blocks all provider mutations, captures notifications locally, uses temporary ignored state, and prints a redacted summary. Missing credentials are reported as untested, never as a passed check. Exit codes: 0 for all selected checks passing, 1 for a failed check, 2 for missing provider credentials, and 3 for no inventory within the bounded test window. No external Slack/email messages are sent by this command.

See [SPEC.md](SPEC.md) for the full contract and runtime limits. Additional phone-number providers implement the internal [Provider interface](src/types.ts); shared scheduling, accounting, state, and notifications stay in the engine.

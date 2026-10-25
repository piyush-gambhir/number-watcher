import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { parseConfig, secret, type Config, type Env } from '../config.js';
import { Http, type Fetch } from '../http.js';
import { delivered, Notifications } from '../notifications/index.js';
import { createProviders } from '../providers/index.js';
import type { Job } from '../types.js';
import { Poller, deliveriesPending, terminal, type PollerOptions } from './poller.js';
import { DynamoStore, type CloudStore } from './store.js';
import { EventBridgeSchedules, type Schedules } from './schedules.js';

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('submit'), requestId: z.string().uuid(), config: z.unknown() }).strict(),
  z.object({ command: z.enum(['poll', 'status', 'cancel', 'resume', 'retry-notifications']), jobId: z.string().uuid() }).strict()
]);
export interface Context { invokedFunctionArn: string; getRemainingTimeInMillis(): number }
export interface AppOptions {
  store: CloudStore;
  schedules: Schedules;
  runtime(): Promise<PollerOptions>;
  now?: () => number;
}
export function createApp(options: AppOptions) {
  return async (event: unknown): Promise<{ jobId: string; status: string; job?: Job }> => {
    const input = commandSchema.safeParse(event);
    if (!input.success) throw new Error('Invalid command: use submit with requestId/config, or poll/status/cancel/resume/retry-notifications with jobId');
    const command = input.data;
    const id = (command.command === 'submit' ? command.requestId : command.jobId).toLowerCase();
    if (command.command === 'status') return { jobId: id, status: 'ok', job: await options.store.load(id) };
    let job: Job;
    if (command.command === 'submit') {
      const config = parseConfig(command.config);
      if (config.pollIntervalSeconds % 60) throw new Error('AWS scheduling requires pollIntervalSeconds to be a whole number of minutes');
      const runtime = await options.runtime();
      runtime.notifications(config);
      runtime.providers(config);
      job = await options.store.create(id, config, (options.now ?? Date.now)());
    } else job = await options.store.load(id);
    if (command.command === 'cancel') await options.store.cancel(id);
    if (command.command === 'resume' || command.command === 'retry-notifications') {
      const updated = await options.store.withLease(id, async session => {
        if (command.command === 'resume') {
          if (['cancelled', 'succeeded'].includes(session.job.status)) throw new Error('Cancelled or completed jobs cannot resume');
          session.job.status = 'queued';
          for (const acquisition of session.job.acquisitions) { acquisition.reconciliationAttempts = 0; acquisition.configurationAttempts = 0; }
        }
        if (command.command === 'retry-notifications') {
          for (const entry of session.job.outbox) for (const delivery of entry.deliveries) if (!delivery.deliveredAt) delivery.attempts = 0;
          const runtime = await options.runtime();
          const poller = new Poller(options.store, runtime);
          await session.save();
          await poller.deliver(session, runtime.notifications(session.job.config));
          if (session.job.config.mode === 'notify' && session.job.status === 'needs_attention' && session.job.outbox.some(e => e.event.type === 'availability.found') && delivered(session.job, 'availability.found')) {
            await poller.finish(session, 'succeeded');
          }
        }
        await session.save();
        return session.job;
      });
      if (!updated) return { jobId: id, status: 'busy' };
      job = updated;
      if (command.command === 'retry-notifications') {
        if (!terminal(job) || deliveriesPending(job)) await options.schedules.ensure(job);
        else await options.schedules.remove(id);
        return { jobId: id, status: job.status };
      }
    }
    // Ensure the recovery trigger exists before the first provider purchase can run.
    if (!terminal(job) || deliveriesPending(job)) await options.schedules.ensure(job);
    const result = await new Poller(options.store, await options.runtime()).run(id);
    if (!result) return { jobId: id, status: 'busy' };
    if (terminal(result) && !deliveriesPending(result)) await options.schedules.remove(id);
    return { jobId: id, status: result.status };
  };
}

const secrets = new SecretsManagerClient({ maxAttempts: 2 });
async function credentials(env: Env): Promise<Env> {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secret(env, 'CREDENTIALS_SECRET_ARN') }));
  return { ...env, ...parseCredentialSecret(result.SecretString ?? 'null') };
}
export function parseCredentialSecret(json: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('Credential secret must contain a JSON object'); }
  const parsed = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()).safeParse(value);
  const reserved = new Set(['NUMBER_WATCHER_TABLE', 'CREDENTIALS_SECRET_ARN', 'SCHEDULE_GROUP', 'SCHEDULE_ROLE_ARN', 'DLQ_ARN']);
  if (!parsed.success || Object.keys(parsed.data).some(key => /^(AWS_|NODE_)/.test(key) || reserved.has(key))) {
    throw new Error('Credential secret must contain only provider and notification environment variables');
  }
  return parsed.data;
}
export async function handler(event: unknown, context: Context) {
  try {
    const env = process.env;
    const store = new DynamoStore(secret(env, 'NUMBER_WATCHER_TABLE'));
    const schedules = new EventBridgeSchedules(secret(env, 'SCHEDULE_GROUP'), context.invokedFunctionArn,
      secret(env, 'SCHEDULE_ROLE_ARN'), secret(env, 'DLQ_ARN'));
    let loaded: Env | undefined;
    return await createApp({ store, schedules, runtime: async () => {
      loaded ??= await credentials(env);
      const fetch: Fetch = (input, init) => {
        if (context.getRemainingTimeInMillis() < 20_000) throw new Error('Invocation is checkpointing before timeout');
        return globalThis.fetch(input, init);
      };
      return {
        remainingMs: () => context.getRemainingTimeInMillis(),
        providers: (config: Config) => createProviders(config, loaded!, new Http(fetch)),
        notifications: (config: Config) => new Notifications(config, loaded!, fetch, undefined, undefined, 1)
      };
    } })(event);
  } catch {
    // Lambda errors are logged automatically. Keep credentials and request content out of them.
    throw new Error('Number Watcher invocation failed. Check the request format, saved job status, AWS permissions, and credential secret.');
  }
}

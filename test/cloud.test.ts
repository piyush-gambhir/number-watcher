import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { ConditionalCheckFailedException, DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { describe, expect, it, vi } from 'vitest';
import { createApp, parseCredentialSecret } from '../src/cloud/handler.js';
import { Poller } from '../src/cloud/poller.js';
import { EventBridgeSchedules } from '../src/cloud/schedules.js';
import { DynamoStore, newJob, type CloudStore, type JobSession } from '../src/cloud/store.js';
import type { Config } from '../src/config.js';
import { queueEvent } from '../src/engine.js';
import type { Job } from '../src/types.js';
import { acknowledged, candidate, channels, config, FakeClock, FakeProvider } from './helpers.js';

class MemoryStore implements CloudStore {
  jobs = new Map<string, Job>();
  cancellations = new Set<string>();
  leases = new Set<string>();
  failSave = false;
  async load(id: string): Promise<Job> { return structuredClone(this.jobs.get(id)!); }
  async create(id: string, config: Config, now: number) {
    const job = newJob(id, config, now);
    const existing = this.jobs.get(id);
    if (existing && existing.fingerprint !== job.fingerprint) throw new Error('Request ID conflict');
    if (!existing) this.jobs.set(id, job);
    return this.load(id);
  }
  async cancel(id: string) { this.cancellations.add(id); }
  async withLease<T>(id: string, work: (session: JobSession) => Promise<T>) {
    if (this.leases.has(id)) return undefined;
    this.leases.add(id);
    try {
      const job = await this.load(id);
      return await work({ job, save: async () => {
        if (this.failSave) throw new Error('Simulated checkpoint failure');
        this.jobs.set(id, structuredClone(job));
      }, cancelled: async () => this.cancellations.has(id) });
    } finally { this.leases.delete(id); }
  }
}
function fixture(numbers = [candidate()], overrides: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const store = new MemoryStore();
  const provider = new FakeProvider('twilio', numbers);
  const schedules = { ensure: vi.fn(async (_job: Job) => {}), remove: vi.fn(async (_id: string) => {}) };
  const runtime = { providers: () => [provider], notifications: () => acknowledged, now: clock.now };
  const app = createApp({ store, schedules, runtime: async () => runtime, now: clock.now });
  const id = randomUUID();
  const request = { command: 'submit', requestId: id, config: config(overrides) };
  return { clock, store, provider, schedules, runtime, app, id, request, poller: new Poller(store, runtime) };
}

describe('single-round Lambda execution', () => {
  it('sets up recovery before the first purchase and treats repeated submissions as the same request', async () => {
    const f = fixture();
    f.provider.acquire.mockImplementation(async (_config, acquisition) => {
      expect(f.schedules.ensure).toHaveBeenCalled();
      const saved = await f.store.load(f.id);
      expect(saved.acquisitions[0].state).toBe('intent');
      return { ...acquisition, state: 'owned', resourceId: 'n1' };
    });
    expect(await f.app(f.request)).toEqual({ jobId: f.id, status: 'succeeded' });
    await f.app(f.request);
    expect(f.provider.acquire).toHaveBeenCalledTimes(1);
    expect(f.schedules.remove).toHaveBeenCalledWith(f.id);
    await expect(f.app({ ...f.request, config: config({ quantity: 2 }) })).rejects.toThrow('conflict');
  });
  it('exits immediately with no matches and skips duplicate ticks before the next poll', async () => {
    const f = fixture([]);
    await f.app(f.request);
    expect(f.clock.time).toBe(Date.parse('2026-01-01T00:00:00Z'));
    await f.app({ command: 'poll', jobId: f.id });
    expect(f.provider.search).toHaveBeenCalledTimes(1);
    f.clock.time += 300_000;
    await f.app({ command: 'poll', jobId: f.id });
    expect(f.provider.search).toHaveBeenCalledTimes(2);
  });
  it('fills quantity across separate invocations without losing progress', async () => {
    const f = fixture([candidate()], { quantity: 2 });
    expect((await f.app(f.request)).status).toBe('running');
    f.provider.search.mockResolvedValue([candidate('twilio', '+12105550102')]);
    f.clock.time += 300_000;
    expect((await f.app({ command: 'poll', jobId: f.id })).status).toBe('succeeded');
    expect(f.provider.acquire).toHaveBeenCalledTimes(2);
    expect((await f.store.load(f.id)).acquisitions.map(a => a.state)).toEqual(['configured', 'configured']);
  });
  it('does not overlap two invocations for the same job', async () => {
    const f = fixture();
    await f.store.create(f.id, config(), f.clock.now());
    let release!: () => void;
    f.provider.preflight.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return 'same'; });
    const first = f.poller.run(f.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await f.poller.run(f.id)).toBeUndefined();
    release();
    await first;
    expect(f.provider.acquire).toHaveBeenCalledTimes(1);
  });
  it('reconciles an ambiguous order over later ticks and never buys a replacement', async () => {
    const f = fixture([candidate(), candidate('twilio', '+12105550102')], { quantity: 2 });
    f.provider.acquire.mockRejectedValue(new Error('connection lost'));
    await f.app(f.request);
    for (let i = 0; i < 3; i++) { f.clock.time += 300_000; await f.app({ command: 'poll', jobId: f.id }); }
    expect((await f.store.load(f.id)).status).toBe('needs_attention');
    expect(f.provider.acquire).toHaveBeenCalledTimes(1);
    expect(f.provider.reconcile).toHaveBeenCalledTimes(3);
  });
  it('recovers a saved intent after a crash using readback, without another acquisition', async () => {
    const f = fixture();
    const job = await f.store.create(f.id, config(), f.clock.now());
    job.acquisitions.push({ candidate: candidate(), state: 'intent', reference: 'before-crash' });
    f.store.jobs.set(f.id, job);
    f.provider.reconcile.mockImplementation(async (_config, a) => ({ ...a, state: 'owned' }));
    expect((await f.poller.run(f.id))?.status).toBe('succeeded');
    expect(f.provider.acquire).not.toHaveBeenCalled();
    expect(f.provider.configure).toHaveBeenCalledTimes(1);
  });
  it('keeps pending orders occupied and checks activation on the next invocation', async () => {
    const f = fixture();
    f.provider.acquire.mockImplementation(async (_config, a) => ({ ...a, state: 'pending', orderId: 'o1' }));
    f.provider.reconcile.mockImplementation(async (_config, a) => ({ ...a, state: 'pending' }));
    await f.app(f.request);
    expect((await f.store.load(f.id)).acquisitions[0].state).toBe('pending');
    expect(f.clock.time).toBe(Date.parse('2026-01-01T00:00:00Z'));
    f.provider.reconcile.mockImplementation(async (_config, a) => ({ ...a, state: 'owned' }));
    f.clock.time += 300_000;
    expect((await f.app({ command: 'poll', jobId: f.id })).status).toBe('succeeded');
    expect(f.provider.acquire).toHaveBeenCalledTimes(1);
  });
  it('retains owned quantity through configuration failures and repairs it on resume', async () => {
    const f = fixture();
    f.provider.configure.mockRejectedValue(new Error('failed'));
    await f.app(f.request);
    await f.app({ command: 'poll', jobId: f.id });
    await f.app({ command: 'poll', jobId: f.id });
    expect((await f.store.load(f.id)).status).toBe('needs_attention');
    f.provider.configure.mockResolvedValue();
    expect((await f.app({ command: 'resume', jobId: f.id })).status).toBe('succeeded');
    expect(f.provider.acquire).toHaveBeenCalledTimes(1);
  });
  it('stops new purchases at the original deadline and does not extend it on duplicate submission', async () => {
    const f = fixture([], { durationHours: 1 });
    await f.app(f.request);
    const deadline = (await f.store.load(f.id)).deadline;
    f.provider.search.mockResolvedValue([candidate()]);
    f.clock.time += 3600_000;
    expect((await f.app(f.request)).status).toBe('expired');
    expect((await f.store.load(f.id)).deadline).toBe(deadline);
    expect(f.provider.acquire).not.toHaveBeenCalled();
  });
  it('stops unresolved pending orders after the recovery grace without freeing the quantity slot', async () => {
    const f = fixture([], { durationHours: 1 });
    const job = await f.store.create(f.id, config({ durationHours: 1 }), f.clock.now());
    job.acquisitions.push({ candidate: candidate(), state: 'pending', reference: 'pending' });
    f.store.jobs.set(f.id, job);
    f.provider.reconcile.mockImplementation(async (_config, a) => ({ ...a, state: 'pending' }));
    f.clock.time += 4200_000;
    expect((await f.poller.run(f.id))?.status).toBe('needs_attention');
    expect((await f.store.load(f.id)).acquisitions[0].state).toBe('pending');
    expect(f.provider.acquire).not.toHaveBeenCalled();
  });
  it('does not purchase if the intent checkpoint fails', async () => {
    const f = fixture();
    f.provider.quote.mockImplementation(async number => { f.store.failSave = true; return number.price!; });
    await expect(f.app(f.request)).rejects.toThrow('checkpoint failure');
    expect(f.provider.acquire).not.toHaveBeenCalled();
  });
  it('defers work near the Lambda timeout', async () => {
    const f = fixture();
    await f.store.create(f.id, config(), f.clock.now());
    await new Poller(f.store, { ...f.runtime, remainingMs: () => 20_000 }).run(f.id);
    expect(f.provider.preflight).not.toHaveBeenCalled();
    expect(f.provider.acquire).not.toHaveBeenCalled();
  });
  it('cancels before looking for numbers', async () => {
    const f = fixture([]);
    await f.app(f.request);
    f.provider.search.mockClear();
    expect((await f.app({ command: 'cancel', jobId: f.id })).status).toBe('cancelled');
    expect(f.provider.search).not.toHaveBeenCalled();
  });
  it('notification retry cannot search or purchase, even for a running purchase job', async () => {
    const f = fixture([], { notifications: channels });
    await f.app(f.request);
    const job = await f.store.load(f.id);
    queueEvent(job, 'number.pending', f.clock.now());
    f.store.jobs.set(f.id, job);
    f.provider.search.mockClear(); f.provider.preflight.mockClear();
    await f.app({ command: 'retry-notifications', jobId: f.id });
    expect(f.provider.search).not.toHaveBeenCalled();
    expect(f.provider.preflight).not.toHaveBeenCalled();
    expect(f.provider.acquire).not.toHaveBeenCalled();
    expect((await f.store.load(f.id)).outbox[0].deliveries[0].deliveredAt).toBeTruthy();
  });
  it('does not create a schedule for sub-minute polling precision or invalid configuration', async () => {
    const f = fixture();
    await expect(f.app({ ...f.request, config: config({ pollIntervalSeconds: 301 }) })).rejects.toThrow('whole number of minutes');
    expect(f.schedules.ensure).not.toHaveBeenCalled();
    expect(f.store.jobs.size).toBe(0);
  });
  it('notifies only after the requested quantity is present in one round', async () => {
    const f = fixture([candidate()], { mode: 'notify', quantity: 2, notifications: channels });
    await f.app(f.request);
    expect((await f.store.load(f.id)).outbox).toHaveLength(0);
    f.clock.time += 300_000;
    f.provider.search.mockResolvedValue([candidate(), candidate('twilio', '+12105550102')]);
    expect((await f.app({ command: 'poll', jobId: f.id })).status).toBe('succeeded');
    expect(f.provider.acquire).not.toHaveBeenCalled();
  });
});

describe('AWS persistence and schedules', () => {
  it('accepts the documented Slack/email/provider secret and rejects runtime configuration overrides', async () => {
    const example = await readFile(new URL('../examples/aws-credentials.json', import.meta.url), 'utf8');
    const values = parseCredentialSecret(example);
    expect(values.NUMBER_WATCHER_EMAIL_TO).toContain(',');
    expect(values.NUMBER_WATCHER_SLACK_WEBHOOK_URL).toContain('hooks.slack.com');
    for (const key of ['AWS_ACCESS_KEY_ID', 'NODE_OPTIONS', 'NUMBER_WATCHER_TABLE', 'SCHEDULE_ROLE_ARN']) {
      expect(() => parseCredentialSecret(JSON.stringify({ [key]: 'override' }))).toThrow('only provider and notification');
    }
    expect(() => parseCredentialSecret('{"API_KEY":123}')).toThrow('only provider and notification');
  });
  it('fences checkpoints with both the lease token and job revision', async () => {
    const id = randomUUID();
    let payload: Uint8Array;
    const send = vi.fn(async (command: any) => {
      if (command instanceof PutItemCommand) { payload = command.input.Item!.payload.B!; return {}; }
      if (command instanceof GetItemCommand) return { Item: { payload: { B: payload! }, revision: { N: '0' } } };
      return {};
    });
    const store = new DynamoStore('jobs', { send } as unknown as DynamoDBClient, () => 1_000_000);
    await store.create(id, config(), 1_000_000);
    await store.withLease(id, async session => { session.job.phase = 'ordering'; await session.save(); });
    const transaction = send.mock.calls.map(([c]) => c).find(c => c instanceof TransactWriteItemsCommand)!;
    const check = transaction.input.TransactItems![0].ConditionCheck!;
    const put = transaction.input.TransactItems![1].Put!;
    expect(check.ConditionExpression).toContain('leaseToken = :token AND expiresAt > :now');
    expect(put.ConditionExpression).toBe('revision = :revision');
    expect(put.Item!.revision.N).toBe('1');
    const saved = JSON.parse(gunzipSync(put.Item!.payload.B!).toString());
    expect(saved.phase).toBe('ordering');
    expect(put.Item!.ttl).toBeUndefined();
  });
  it('does not run work when DynamoDB rejects an overlapping lease', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(UpdateItemCommand);
      throw new ConditionalCheckFailedException({ $metadata: {}, message: 'busy' });
    });
    const work = vi.fn();
    expect(await new DynamoStore('jobs', { send } as unknown as DynamoDBClient).withLease(randomUUID(), work)).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
  });
  it('uses only job IDs in scheduled events and leaves time for recovery and delivery', async () => {
    const send = vi.fn(async (_command: any) => ({}));
    const now = () => Date.parse('2026-01-01T00:00:00Z');
    const job = newJob(randomUUID(), config(), now());
    await new EventBridgeSchedules('group', 'function', 'role', 'dlq', { send } as unknown as SchedulerClient, now).ensure(job);
    const input = send.mock.calls[0][0].input;
    expect(input.ScheduleExpression).toBe('rate(5 minutes)');
    expect(input.ActionAfterCompletion).toBe('DELETE');
    expect(input.EndDate.getTime()).toBeGreaterThan(Date.parse(job.deadline!) + 1800_000);
    expect(JSON.parse(input.Target.Input)).toEqual({ command: 'poll', jobId: job.id });
    expect(input.Target.DeadLetterConfig.Arn).toBe('dlq');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner, searchRound } from '../src/engine.js';
import type { Store } from '../src/store.js';
import { progress } from '../src/types.js';
import { acknowledged, candidate, channels, config, FakeClock, FakeProvider, fixtureStore } from './helpers.js';

describe('durable acquisition and notify jobs', () => {
  let store: Store;
  let clean: () => Promise<void>;
  let clock: FakeClock;
  beforeEach(async () => { ({ store, clean } = await fixtureStore()); clock = new FakeClock(); });
  afterEach(async () => { await clean(); });
  const runWith = (providers: FakeProvider[], stopped?: () => boolean) => new Runner(store, {
    clock, providers: () => providers, notifications: () => acknowledged, stopped
  });

  it('fills one shared quantity across both providers and never repurchases on resume', async () => {
    const twilio = new FakeProvider('twilio', [candidate()]);
    const telnyx = new FakeProvider('telnyx', [candidate('telnyx', '+12105550102'), candidate('telnyx', '+12105550103')]);
    const job = await store.add(config({ quantity: 3 }));
    const runner = runWith([twilio, telnyx]);
    const result = await runner.run(job.id);
    expect(result.status).toBe('succeeded');
    expect(progress(result).configured).toBe(3);
    expect(twilio.acquire).toHaveBeenCalledTimes(1);
    expect(telnyx.acquire).toHaveBeenCalledTimes(2);
    await runner.run(job.id);
    expect(twilio.acquire).toHaveBeenCalledTimes(1);
    expect(telnyx.acquire).toHaveBeenCalledTimes(2);
  });
  it('blocks both providers after an ambiguous purchase, including on resume', async () => {
    const twilio = new FakeProvider('twilio', [candidate()]);
    twilio.acquire.mockImplementation(async (_c, a) => ({ ...a, state: 'unknown' }));
    const telnyx = new FakeProvider('telnyx', [candidate('telnyx', '+12105550102')]);
    const job = await store.add(config({ quantity: 2 }));
    const runner = runWith([twilio, telnyx]);
    expect((await runner.run(job.id)).status).toBe('needs_attention');
    expect(twilio.reconcile).toHaveBeenCalledTimes(3);
    expect(telnyx.acquire).not.toHaveBeenCalled();
    await runner.run(job.id);
    expect(twilio.acquire).toHaveBeenCalledTimes(1);
    expect(telnyx.acquire).not.toHaveBeenCalled();
  });
  it('recovers a persisted intent through reconciliation without repeating the purchase', async () => {
    const provider = new FakeProvider('twilio');
    provider.reconcile.mockImplementation(async (_c, a) => ({ ...a, state: 'owned', resourceId: 'recovered' }));
    const job = await store.add(config());
    job.acquisitions.push({ candidate: candidate(), reference: 'saved-intent', state: 'intent' });
    await store.save(job);
    const result = await runWith([provider]).run(job.id);
    expect(result.status).toBe('succeeded');
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.configure).toHaveBeenCalledTimes(1);
  });
  it('retains purchased quantity when routing fails and repairs it on resume', async () => {
    const twilio = new FakeProvider('twilio', [candidate()]);
    const telnyx = new FakeProvider('telnyx', [candidate('telnyx', '+12105550102')]);
    twilio.configure.mockRejectedValue(new Error('Route mismatch'));
    const job = await store.add(config());
    const runner = runWith([twilio, telnyx]);
    const partial = await runner.run(job.id);
    expect(partial.status).toBe('needs_attention');
    expect(progress(partial)).toMatchObject({ remaining: 0, configured: 0, owned: 1 });
    expect(telnyx.acquire).not.toHaveBeenCalled();
    twilio.configure.mockResolvedValue();
    expect((await runner.run(job.id)).status).toBe('succeeded');
    expect(twilio.acquire).toHaveBeenCalledTimes(1);
  });
  it('keeps pending Telnyx orders occupied until activation', async () => {
    const provider = new FakeProvider('telnyx', [candidate('telnyx')]);
    provider.acquire.mockImplementation(async (_c, a) => ({ ...a, state: 'pending', orderId: 'order-1' }));
    provider.reconcile.mockImplementationOnce(async (_c, a) => ({ ...a, state: 'pending' }))
      .mockImplementationOnce(async (_c, a) => ({ ...a, state: 'owned', resourceId: 'number-1' }));
    const job = await store.add(config());
    const result = await runWith([provider]).run(job.id);
    expect(result.status).toBe('succeeded');
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(clock.now() - Date.parse(result.startedAt!)).toBe(30000);
    expect(result.outbox.find(e => e.event.type === 'number.pending')?.event.data.acquisition).toMatchObject({ state: 'pending' });
  });
  it('does not accumulate notify sightings from prior rounds', async () => {
    const provider = new FakeProvider('twilio');
    provider.search.mockResolvedValueOnce([candidate()]).mockResolvedValueOnce([candidate('twilio', '+12105550102')])
      .mockResolvedValue([candidate(), candidate('twilio', '+12105550102')]);
    const job = await store.add(config({ mode: 'notify', quantity: 2, notifications: channels }));
    const result = await runWith([provider]).run(job.id);
    expect(result.status).toBe('succeeded');
    expect(provider.search).toHaveBeenCalledTimes(3);
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(provider.configure).not.toHaveBeenCalled();
    expect(result.outbox.filter(e => e.event.type === 'availability.found')).toHaveLength(1);
  });
  it('does not buy if a price refresh crosses the absolute deadline', async () => {
    const provider = new FakeProvider('twilio', [candidate()]);
    provider.quote.mockImplementation(async c => { clock.time += 3600_000; return c.price!; });
    const job = await store.add(config({ durationHours: 1 }));
    const result = await runWith([provider]).run(job.id);
    expect(result.status).toBe('expired');
    expect(provider.acquire).not.toHaveBeenCalled();
  });
  it('preserves the deadline on resume and does not purchase a replacement', async () => {
    const provider = new FakeProvider('twilio', [candidate()]);
    const job = await store.add(config());
    job.startedAt = new Date(clock.now() - 25 * 3600_000).toISOString();
    job.deadline = new Date(clock.now() - 3600_000).toISOString();
    job.nextPollAt = job.startedAt;
    job.status = 'running';
    await store.save(job);
    const result = await runWith([provider]).run(job.id);
    expect(result.deadline).toBe(job.deadline);
    expect(result.status).toBe('expired');
    expect(provider.search).not.toHaveBeenCalled();
  });
  it('excludes numbers already owned by either account', async () => {
    const twilio = new FakeProvider('twilio', [candidate()]);
    const telnyx = new FakeProvider('telnyx');
    telnyx.ownedNumbers.mockResolvedValue(['+12105550101']);
    expect((await searchRound(config(), [twilio, telnyx])).candidates).toEqual([]);
  });
  it('stops before a second purchase when cancelled between acquisitions', async () => {
    let cancelled = false;
    const provider = new FakeProvider('twilio', [candidate(), candidate('twilio', '+12105550102')]);
    provider.configure.mockImplementation(async () => { cancelled = true; });
    const job = await store.add(config({ quantity: 2 }));
    const result = await runWith([provider], () => cancelled).run(job.id);
    expect(result.status).toBe('cancelled');
    expect(progress(result).configured).toBe(1);
    expect(provider.acquire).toHaveBeenCalledTimes(1);
  });
  it('cannot process another request while an earlier write is unresolved', async () => {
    const existing = await store.add(config());
    existing.acquisitions.push({ candidate: candidate(), reference: 'pending', state: 'unknown' });
    await store.save(existing);
    const next = await store.add(config());
    await expect(runWith([]).run(next.id)).rejects.toThrow(existing.id);
  });
  it('persists intent before submitting and stops if persistence fails', async () => {
    const provider = new FakeProvider('twilio', [candidate()]);
    const job = await store.add(config());
    const save = store.save.bind(store);
    vi.spyOn(store, 'save').mockImplementation(async current => {
      if (current.acquisitions.some(a => a.state === 'intent')) throw new Error('Disk full');
      await save(current);
    });
    await expect(runWith([provider]).run(job.id)).rejects.toThrow('Disk full');
    expect(provider.acquire).not.toHaveBeenCalled();
  });
  it('refuses a second worker lock', async () => {
    const release = await store.lock();
    try { await expect(store.lock()).rejects.toThrow(); } finally { await release(); }
  });
  it('can explicitly resume after preflight is repaired without creating a second request', async () => {
    const provider = new FakeProvider('twilio', [candidate()]);
    provider.preflight.mockRejectedValueOnce(new Error('Credentials missing'));
    const job = await store.add(config());
    const runner = runWith([provider]);
    expect((await runner.run(job.id)).status).toBe('failed');
    expect(provider.acquire).not.toHaveBeenCalled();
    expect((await runner.run(job.id)).status).toBe('succeeded');
    expect(provider.acquire).toHaveBeenCalledTimes(1);
  });
  it('can cancel an unstarted request without provider or notification credentials', async () => {
    const job = await store.add(config());
    await store.cancel(job.id);
    const providers = vi.fn(() => { throw new Error('Should not create providers'); });
    const notifications = vi.fn(() => { throw new Error('Should not create senders'); });
    expect((await new Runner(store, { providers, notifications, clock }).run(job.id)).status).toBe('cancelled');
    expect(providers).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
  });
  it.each([
    { interval: 300, hours: 24, rounds: 288 },
    { interval: 600, hours: 1, rounds: 6 }
  ])('polls immediately and on fixed slots until expiry: %j', async ({ interval, hours, rounds }) => {
    const provider = new FakeProvider('twilio');
    const observed: number[] = [];
    const start = clock.now();
    provider.search.mockImplementation(async () => { observed.push(clock.now() - start); return []; });
    const job = await store.add(config({ pollIntervalSeconds: interval, durationHours: hours }));
    const runner = runWith([provider]);
    // Exercise the scheduler with virtual time; cancellation-aware waiting has separate coverage.
    vi.spyOn(runner, 'pause').mockImplementation(async (_job, ms) => { clock.time += ms; });
    const result = await runner.run(job.id);
    expect(result.status).toBe('expired');
    expect(observed).toEqual(Array.from({ length: rounds }, (_, i) => i * interval * 1000));
    expect(Date.parse(result.deadline!) - Date.parse(result.startedAt!)).toBe(hours * 3600_000);
    expect(provider.acquire).not.toHaveBeenCalled();
  }, 15000);
  it('fills quantity over separate polls without reacquiring an earlier number', async () => {
    const provider = new FakeProvider('twilio');
    provider.search.mockResolvedValueOnce([candidate()]).mockResolvedValue([candidate(), candidate('twilio', '+12105550102')]);
    const job = await store.add(config({ quantity: 2 }));
    const runner = runWith([provider]);
    vi.spyOn(runner, 'pause').mockImplementation(async (_job, ms) => { clock.time += ms; });
    const result = await runner.run(job.id);
    expect(result.status).toBe('succeeded');
    expect(provider.acquire.mock.calls.map(([, a]) => a.candidate.phoneNumber)).toEqual(['+12105550101', '+12105550102']);
    expect(clock.now() - Date.parse(result.startedAt!)).toBe(300_000);
  });
  it('skips elapsed slots after slow searches and never overlaps polling rounds', async () => {
    const provider = new FakeProvider('twilio');
    const start = clock.now();
    const observed: number[] = [];
    let inFlight = 0;
    provider.search.mockImplementation(async () => {
      expect(inFlight).toBe(0);
      inFlight++;
      observed.push(clock.now() - start);
      await clock.sleep(420_000);
      inFlight--;
      return [];
    });
    const job = await store.add(config({ durationHours: 1 }));
    const runner = runWith([provider]);
    vi.spyOn(runner, 'pause').mockImplementation(async (_job, ms) => { clock.time += ms; });
    expect((await runner.run(job.id)).status).toBe('expired');
    expect(observed).toEqual([0, 600_000, 1_200_000, 1_800_000, 2_400_000, 3_000_000]);
  });
  it('keeps pending orders occupying quantity through the acquisition deadline and recovery budget', async () => {
    const provider = new FakeProvider('telnyx', [candidate('telnyx')]);
    provider.acquire.mockImplementation(async (_c, a) => ({ ...a, state: 'pending', orderId: 'pending-order' }));
    provider.reconcile.mockImplementation(async (_c, a) => ({ ...a, state: 'pending' }));
    const job = await store.add(config({ quantity: 2, durationHours: 1 }));
    const runner = runWith([provider]);
    vi.spyOn(runner, 'pause').mockImplementation(async (_job, ms) => { clock.time += ms; });
    const result = await runner.run(job.id);
    expect(result.status).toBe('needs_attention');
    expect(progress(result)).toMatchObject({ pending: 1, remaining: 1, configured: 0 });
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(Date.parse(result.deadline!) + 600_000);
  });
});

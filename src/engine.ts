import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { ApiError } from './http.js';
import { matches, selectCandidates, withinBudget } from './matching.js';
import { delivered, Notifications } from './notifications/index.js';
import { fingerprint, Store } from './store.js';
import { occupied, progress, systemClock, unresolved, type Acquisition, type Candidate, type Clock, type Job, type Provider } from './types.js';

export interface DeliveryService { deliver(job: Job, save: () => Promise<void>, retry?: boolean, until?: number): Promise<void> }
export interface RunnerOptions {
  providers(config: Config): Provider[];
  notifications(config: Config): DeliveryService;
  clock?: Clock;
  stopped?: () => boolean;
  log?: (message: Record<string, unknown>) => void;
}
const safeError = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Operation failed';

export function queueEvent(job: Job, type: string, now: number, data: Record<string, unknown> = {}): void {
  job.outbox.push({ event: {
    id: randomUUID(), type, jobId: job.id, jobName: job.config.name,
    mode: job.config.mode, occurredAt: new Date(now).toISOString(), data: structuredClone({ progress: progress(job), ...data })
  }, deliveries: (job.config.notifications?.channels ?? []).map(c => ({ channelId: c.id, attempts: 0 })) });
}

export async function searchRound(config: Config, providers: Provider[]): Promise<{
  candidates: Candidate[]; errors: string[]; disabled: Provider['type'][];
  exclusions: { provider: Provider['type']; phoneNumber: string; reason: string }[];
}> {
  const results = await Promise.all(providers.map(async provider => {
    const candidates: Candidate[] = [];
    const errors: string[] = [];
    let disabled = false;
    let owned: string[] = [];
    try {
      owned = await provider.ownedNumbers();
      const searches = await Promise.allSettled(config.areaCodes.map(code => provider.search(config, code, config.quantity)));
      for (const [index, result] of searches.entries()) {
        if (result.status === 'fulfilled') candidates.push(...result.value);
        else {
          errors.push(`${provider.type}/${config.areaCodes[index]}: ${safeError(result.reason)}`);
          if (result.reason instanceof ApiError && [401, 403].includes(result.reason.status)) disabled = true;
        }
      }
      if (config.budget && candidates.some(c => !c.price)) {
        const price = await provider.quote(candidates.find(c => !c.price)!);
        for (const candidate of candidates) if (!candidate.price) candidate.price = price;
      }
    } catch (error) {
      errors.push(`${provider.type}: ${safeError(error)}`);
      if (error instanceof ApiError && [401, 403].includes(error.status)) disabled = true;
      return { candidates: [], errors, disabled, provider: provider.type, owned: [] as string[] };
    }
    return { candidates, errors, disabled, provider: provider.type, owned };
  }));
  const excluded = new Set(results.flatMap(r => r.owned));
  const exclusions = results.flatMap(r => r.candidates).flatMap(candidate => {
    const reason = !matches(config, candidate) ? 'Required country, type, area code, or capabilities did not match'
      : excluded.has(candidate.phoneNumber) ? 'Already owned by a selected account'
      : !withinBudget(config, candidate.price) ? 'Price unknown, unsupported, or above a configured ceiling' : undefined;
    return reason ? [{ provider: candidate.provider, phoneNumber: candidate.phoneNumber, reason }] : [];
  });
  return {
    candidates: selectCandidates(config, results.filter(r => !r.disabled).flatMap(r => r.candidates), excluded),
    errors: results.flatMap(r => r.errors), disabled: results.filter(r => r.disabled).map(r => r.provider), exclusions
  };
}

export class Runner {
  readonly clock: Clock;
  constructor(readonly store: Store, readonly options: RunnerOptions) { this.clock = options.clock ?? systemClock; }
  async cancelled(job: Job): Promise<boolean> { return !!this.options.stopped?.() || this.store.cancelled(job.id); }
  async pause(job: Job, ms: number): Promise<void> {
    const until = this.clock.now() + ms;
    while (this.clock.now() < until && !await this.cancelled(job)) await this.clock.sleep(Math.min(1000, until - this.clock.now()));
  }
  async preflight(job: Job, providers: Provider[]): Promise<void> {
    for (const provider of providers) {
      const identity = await provider.preflight(job.config);
      if (job.identities[provider.type] && job.identities[provider.type] !== identity) throw new Error(`${provider.type} credentials no longer match the saved identity`);
      job.identities[provider.type] = identity;
      await this.store.save(job);
    }
  }
  async run(id: string): Promise<Job> {
    const release = await this.store.lock();
    try {
      const job = await this.store.load(id);
      if (['succeeded', 'expired', 'cancelled'].includes(job.status) && !unresolved(job)) return job;
      const other = (await this.store.list()).find(j => j.id !== id && (unresolved(j) || j.status === 'running'));
      if (other) throw new Error(`Reconcile or resume job ${other.id} before processing another request`);
      if (await this.cancelled(job) && !unresolved(job)) {
        job.status = 'cancelled';
        job.phase = 'idle';
        if (!job.outbox.some(e => e.event.type === 'job.cancelled')) queueEvent(job, 'job.cancelled', this.clock.now());
        await this.store.save(job);
        return job;
      }
      let notifier: DeliveryService;
      try { notifier = this.options.notifications(job.config); }
      catch {
        job.error = 'Notification configuration is invalid or credentials are missing';
        job.status = unresolved(job) ? 'needs_attention' : 'failed';
        job.phase = 'idle';
        queueEvent(job, `job.${job.status}`, this.clock.now(), { error: job.error });
        await this.store.save(job);
        return job;
      }
      if (job.config.mode === 'notify' && job.outbox.some(e => e.event.type === 'availability.found')) {
        await notifier.deliver(job, () => this.store.save(job), true);
        return await this.finish(job, delivered(job, 'availability.found') ? 'succeeded' : 'needs_attention', notifier);
      }
      try {
        if (fingerprint(job.config) !== job.fingerprint) throw new Error('Saved configuration fingerprint mismatch');
        const providers = this.options.providers(job.config);
        await this.preflight(job, providers);
        job.disabledProviders = [];
        if (!job.startedAt) {
          job.startedAt = new Date(this.clock.now()).toISOString();
          job.deadline = new Date(this.clock.now() + job.config.durationHours * 3600_000).toISOString();
          job.nextPollAt = job.startedAt;
        }
        job.status = 'running';
        job.error = undefined;
        await this.store.save(job);
        const deadline = Date.parse(job.deadline!);
        const recoveryUntil = Math.max(deadline + 600_000, this.clock.now() + 600_000);
        for (const acquisition of job.acquisitions) {
          if (!['configured', 'rejected'].includes(acquisition.state)) {
            const provider = providers.find(p => p.type === acquisition.candidate.provider)!;
            if (!await this.settle(job, acquisition, provider, notifier, recoveryUntil)) return await this.finish(job, 'needs_attention', notifier);
          } else if (acquisition.state === 'configured' && !acquisition.eventQueued) {
            this.acquiredEvent(job, acquisition);
            await this.store.save(job);
          }
        }
        while (true) {
          if (await this.cancelled(job)) return await this.finish(job, unresolved(job) ? 'needs_attention' : 'cancelled', notifier);
          if (job.config.mode === 'purchase' && progress(job).configured === job.config.quantity) return await this.finish(job, 'succeeded', notifier);
          if (this.clock.now() >= deadline) return await this.finish(job, 'expired', notifier);
          const next = Date.parse(job.nextPollAt!);
          if (next > this.clock.now()) { await this.pause(job, Math.min(next, deadline) - this.clock.now()); continue; }
          job.phase = 'searching';
          await this.store.save(job);
          const active = providers.filter(p => !job.disabledProviders.includes(p.type));
          const round = await searchRound(job.config, active);
          const already = new Set(occupied(job).map(a => a.candidate.phoneNumber));
          round.candidates = round.candidates.filter(c => !already.has(c.phoneNumber));
          job.lastRound = { observedAt: new Date(this.clock.now()).toISOString(), candidates: round.candidates, errors: round.errors, exclusions: round.exclusions };
          for (const type of round.disabled) {
            if (!job.disabledProviders.includes(type)) {
              job.disabledProviders.push(type);
              queueEvent(job, 'provider.degraded', this.clock.now(), { provider: type });
            }
          }
          const interval = job.config.pollIntervalSeconds * 1000;
          job.nextPollAt = new Date(Date.parse(job.startedAt!) + (Math.floor((this.clock.now() - Date.parse(job.startedAt!)) / interval) + 1) * interval).toISOString();
          await this.store.save(job);
          this.options.log?.({ jobId: job.id, matches: round.candidates.length, errors: round.errors, ...progress(job) });
          if (!providers.some(p => !job.disabledProviders.includes(p.type))) throw new Error('No usable providers remain');
          if (await this.cancelled(job)) continue;
          if (this.clock.now() >= deadline) continue;
          if (job.config.mode === 'notify') {
            if (round.candidates.length >= job.config.quantity) {
              queueEvent(job, 'availability.found', this.clock.now(), { observedAt: job.lastRound.observedAt, candidates: round.candidates.slice(0, job.config.quantity) });
              job.phase = 'notifying';
              await this.store.save(job);
              await notifier.deliver(job, () => this.store.save(job), false, recoveryUntil);
              return await this.finish(job, delivered(job, 'availability.found') ? 'succeeded' : 'needs_attention', notifier);
            }
          } else {
            for (const candidate of round.candidates) {
              if (occupied(job).length >= job.config.quantity || this.clock.now() >= deadline || await this.cancelled(job)) break;
              const provider = providers.find(p => p.type === candidate.provider)!;
              try { candidate.price = await provider.quote(candidate); }
              catch (error) { job.lastRound.errors.push(`${provider.type}/quote: ${safeError(error)}`); continue; }
              if (!matches(job.config, candidate) || !withinBudget(job.config, candidate.price)) {
                job.lastRound.exclusions?.push({ provider: candidate.provider, phoneNumber: candidate.phoneNumber, reason: 'Fresh quote did not meet the requested budget or capabilities' });
                continue;
              }
              if (this.clock.now() >= deadline || await this.cancelled(job)) break;
              const acquisition: Acquisition = { candidate, reference: `nw:${job.id}:${job.acquisitions.length}`, state: 'intent' };
              job.acquisitions.push(acquisition);
              job.phase = 'ordering';
              await this.store.save(job);
              let outcome: Acquisition;
              try { outcome = await provider.acquire(job.config, acquisition); }
              catch { outcome = { ...acquisition, state: 'unknown', error: 'Purchase adapter did not return a conclusive outcome' }; }
              Object.assign(acquisition, outcome);
              await this.store.save(job);
              if (!await this.settle(job, acquisition, provider, notifier, recoveryUntil)) return await this.finish(job, 'needs_attention', notifier);
            }
          }
          await notifier.deliver(job, () => this.store.save(job), false, recoveryUntil);
        }
      } catch (error) {
        job.error = safeError(error);
        return await this.finish(job, unresolved(job) ? 'needs_attention' : 'failed', notifier);
      }
    } finally { await release(); }
  }
  acquiredEvent(job: Job, acquisition: Acquisition): void {
    queueEvent(job, 'number.acquired', this.clock.now(), { acquisition });
    acquisition.eventQueued = true;
  }
  async settle(job: Job, acquisition: Acquisition, provider: Provider, notifier: DeliveryService, until: number): Promise<boolean> {
    if (acquisition.state === 'rejected') return true;
    if (['intent', 'unknown'].includes(acquisition.state)) {
      job.phase = 'reconciling';
      for (let attempt = 0; attempt < 3 && this.clock.now() < until; attempt++) {
        if (attempt) await this.pause(job, attempt * 1000);
        try { Object.assign(acquisition, await provider.reconcile(job.config, acquisition)); }
        catch { acquisition.error = 'Reconciliation request failed'; }
        await this.store.save(job);
        if (!['intent', 'unknown'].includes(acquisition.state)) break;
      }
      if (['intent', 'unknown'].includes(acquisition.state)) return false;
    }
    if (acquisition.state === 'pending' && !job.outbox.some(e => e.event.type === 'number.pending' && e.event.data.reference === acquisition.reference)) {
      queueEvent(job, 'number.pending', this.clock.now(), { reference: acquisition.reference, acquisition });
      await this.store.save(job);
      await notifier.deliver(job, () => this.store.save(job), false, until);
    }
    while (acquisition.state === 'pending' && this.clock.now() < until && !await this.cancelled(job)) {
      job.phase = 'waiting_activation';
      try { Object.assign(acquisition, await provider.reconcile(job.config, acquisition)); }
      catch { acquisition.error = 'Order status check failed; order remains unresolved'; }
      await this.store.save(job);
      if (acquisition.state === 'pending') await this.pause(job, Math.min(30000, until - this.clock.now()));
    }
    if (['rejected'].includes(acquisition.state)) return true;
    if (acquisition.state !== 'owned') return acquisition.state === 'configured';
    job.phase = 'configuring';
    for (let attempt = 0; attempt < 3 && this.clock.now() < until; attempt++) {
      if (attempt) await this.pause(job, attempt * 1000);
      try { await provider.configure(job.config, acquisition); }
      catch (error) { acquisition.error = safeError(error); await this.store.save(job); continue; }
      acquisition.state = 'configured';
      acquisition.error = undefined;
      this.acquiredEvent(job, acquisition);
      await this.store.save(job);
      await notifier.deliver(job, () => this.store.save(job), false, until);
      return true;
    }
    return false;
  }
  async finish(job: Job, status: Job['status'], notifier: DeliveryService): Promise<Job> {
    job.status = status;
    job.phase = 'idle';
    const event = status === 'succeeded' ? 'job.completed' : `job.${status}`;
    if (!job.outbox.some(e => e.event.type === event)) queueEvent(job, event, this.clock.now(), {
      status, error: job.error, acquisitions: job.acquisitions, lastRound: job.lastRound
    });
    await this.store.save(job);
    await notifier.deliver(job, () => this.store.save(job));
    return job;
  }
  async retryNotifications(id: string): Promise<Job> {
    const release = await this.store.lock();
    try {
      const job = await this.store.load(id);
      const notifier = this.options.notifications(job.config);
      await notifier.deliver(job, () => this.store.save(job), true);
      if (job.config.mode === 'notify' && job.status === 'needs_attention' && job.outbox.some(e => e.event.type === 'availability.found') && delivered(job, 'availability.found')) return await this.finish(job, 'succeeded', notifier);
      return job;
    } finally { await release(); }
  }
}

export const defaultNotifications = (config: Config) => new Notifications(config);

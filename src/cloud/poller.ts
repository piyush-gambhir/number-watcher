import type { Config } from '../config.js';
import { queueEvent, searchRound, type DeliveryService } from '../engine.js';
import { matches, withinBudget } from '../matching.js';
import { delivered } from '../notifications/index.js';
import { occupied, progress, unresolved, type Acquisition, type Job, type Provider } from '../types.js';
import type { CloudStore, JobSession } from './store.js';

export const terminal = (job: Job): boolean => !['queued', 'running'].includes(job.status);
export const deliveriesPending = (job: Job): boolean => job.outbox.some(e => e.deliveries.some(d => !d.deliveredAt && d.attempts < 3));
export interface PollerOptions {
  providers(config: Config): Provider[];
  notifications(config: Config): DeliveryService;
  now?: () => number;
  remainingMs?: () => number;
}

// One bounded round. Pending activation and delivery retries continue on a later invocation.
export class Poller {
  readonly now: () => number;
  constructor(readonly store: CloudStore, readonly options: PollerOptions) { this.now = options.now ?? Date.now; }
  hasTime(): boolean { return (this.options.remainingMs?.() ?? Infinity) > 25_000; }
  async run(id: string): Promise<Job | undefined> {
    return this.store.withLease(id, session => this.tick(session));
  }
  async finish(session: JobSession, status: Job['status']): Promise<void> {
    const job = session.job;
    job.status = status;
    job.phase = 'idle';
    const type = status === 'succeeded' ? 'job.completed' : `job.${status}`;
    if (!job.outbox.some(e => e.event.type === type)) queueEvent(job, type, this.now(), {
      status, error: job.error, acquisitions: job.acquisitions, lastRound: job.lastRound
    });
    await session.save();
  }
  async deliver(session: JobSession, notifier: DeliveryService): Promise<void> {
    if (!this.hasTime()) return;
    await notifier.deliver(session.job, () => session.save(), false, this.now() + (this.options.remainingMs?.() ?? Infinity) - 20_000);
  }
  async tick(session: JobSession): Promise<Job> {
    const job = session.job;
    if (!this.hasTime()) return job;
    let notifier: DeliveryService;
    try { notifier = this.options.notifications(job.config); }
    catch {
      job.error = 'Notification configuration is invalid or credentials are missing';
      await this.finish(session, unresolved(job) ? 'needs_attention' : 'failed');
      return job;
    }
    if (terminal(job)) {
      await this.deliver(session, notifier);
      if (job.status === 'needs_attention' && job.config.mode === 'notify' && job.outbox.some(e => e.event.type === 'availability.found') && delivered(job, 'availability.found')) {
        await this.finish(session, 'succeeded'); await this.deliver(session, notifier);
      }
      return job;
    }
    if (await session.cancelled() && !unresolved(job)) {
      await this.finish(session, 'cancelled'); await this.deliver(session, notifier); return job;
    }
    const found = job.outbox.some(e => e.event.type === 'availability.found');
    if (found) {
      await this.deliver(session, notifier);
      if (delivered(job, 'availability.found')) await this.finish(session, 'succeeded');
      else if (!deliveriesPending(job)) await this.finish(session, 'needs_attention');
      await this.deliver(session, notifier);
      return job;
    }
    const deadline = Date.parse(job.deadline!);
    if (!unresolved(job) && job.config.mode === 'purchase' && progress(job).configured === job.config.quantity) {
      await this.finish(session, 'succeeded'); await this.deliver(session, notifier); return job;
    }
    if (!unresolved(job) && this.now() >= deadline) {
      await this.finish(session, 'expired'); await this.deliver(session, notifier); return job;
    }
    if (!unresolved(job) && Date.parse(job.nextPollAt!) > this.now()) { await this.deliver(session, notifier); return job; }
    try {
      const providers = this.options.providers(job.config);
      for (const provider of providers) {
        if (!this.hasTime()) return job;
        const identity = await provider.preflight(job.config);
        if (job.identities[provider.type] && job.identities[provider.type] !== identity) throw new Error(`${provider.type} credentials no longer match the saved identity`);
        job.identities[provider.type] = identity;
      }
      job.status = 'running';
      job.error = undefined;
      await session.save();
      for (const acquisition of job.acquisitions) {
        if (!['configured', 'rejected'].includes(acquisition.state)) {
          const provider = providers.find(p => p.type === acquisition.candidate.provider)!;
          if (!await this.settle(session, acquisition, provider)) { await this.deliver(session, notifier); return job; }
        }
      }
      if (await session.cancelled()) await this.finish(session, 'cancelled');
      else if (job.config.mode === 'purchase' && progress(job).configured === job.config.quantity) await this.finish(session, 'succeeded');
      else if (this.now() >= deadline) await this.finish(session, 'expired');
      else if (this.hasTime() && Date.parse(job.nextPollAt!) <= this.now()) {
        job.phase = 'searching';
        const round = await searchRound(job.config, providers);
        const already = new Set(occupied(job).map(a => a.candidate.phoneNumber));
        round.candidates = round.candidates.filter(c => !already.has(c.phoneNumber));
        job.lastRound = { observedAt: new Date(this.now()).toISOString(), candidates: round.candidates, errors: round.errors, exclusions: round.exclusions };
        for (const provider of round.disabled) {
          if (!job.disabledProviders.includes(provider)) queueEvent(job, 'provider.degraded', this.now(), { provider });
        }
        job.disabledProviders = round.disabled;
        const interval = job.config.pollIntervalSeconds * 1000;
        job.nextPollAt = new Date(Date.parse(job.startedAt!) + (Math.floor((this.now() - Date.parse(job.startedAt!)) / interval) + 1) * interval).toISOString();
        await session.save();
        if (round.disabled.length === providers.length) throw new Error('No usable providers remain');
        if (this.now() < deadline && !await session.cancelled() && this.hasTime()) {
          if (job.config.mode === 'notify') {
            if (round.candidates.length >= job.config.quantity) {
              queueEvent(job, 'availability.found', this.now(), { observedAt: job.lastRound.observedAt, candidates: round.candidates.slice(0, job.config.quantity) });
              job.phase = 'notifying';
              await session.save();
              await this.deliver(session, notifier);
              if (delivered(job, 'availability.found')) await this.finish(session, 'succeeded');
            }
          } else {
            for (const candidate of round.candidates) {
              if (occupied(job).length >= job.config.quantity || !this.hasTime() || this.now() >= deadline || await session.cancelled()) break;
              const provider = providers.find(p => p.type === candidate.provider)!;
              try { candidate.price = await provider.quote(candidate); }
              catch { job.lastRound.errors.push(`${provider.type}/quote: Fresh quote could not be obtained`); continue; }
              if (!matches(job.config, candidate) || !withinBudget(job.config, candidate.price)) continue;
              if (!this.hasTime() || this.now() >= deadline || await session.cancelled()) break;
              const acquisition: Acquisition = { candidate, reference: `nw:${job.id}:${job.acquisitions.length}`, state: 'intent' };
              job.acquisitions.push(acquisition);
              job.phase = 'ordering';
              await session.save();
              try { Object.assign(acquisition, await provider.acquire(job.config, acquisition)); }
              catch { acquisition.state = 'unknown'; acquisition.error = 'Purchase outcome is uncertain; reconcile before another purchase'; }
              await session.save();
              if (!await this.settle(session, acquisition, provider)) break;
            }
            if (!terminal(job) && progress(job).configured === job.config.quantity) await this.finish(session, 'succeeded');
          }
        }
      }
    } catch {
      // Never include provider credentials, request payloads, or raw exception text in cloud logs/events.
      if (this.hasTime()) {
        job.error = 'Provider operation or checkpoint failed; inspect saved progress before resuming';
        await this.finish(session, unresolved(job) ? 'needs_attention' : 'failed');
      }
    }
    await this.deliver(session, notifier);
    return job;
  }
  async settle(session: JobSession, acquisition: Acquisition, provider: Provider): Promise<boolean> {
    const job = session.job;
    if (!this.hasTime()) return false;
    if (['intent', 'unknown', 'pending'].includes(acquisition.state)) {
      const uncertain = acquisition.state !== 'pending';
      job.phase = uncertain ? 'reconciling' : 'waiting_activation';
      if (uncertain) acquisition.reconciliationAttempts = (acquisition.reconciliationAttempts ?? 0) + 1;
      await session.save();
      try { Object.assign(acquisition, await provider.reconcile(job.config, acquisition)); }
      catch { acquisition.error = 'Reconciliation failed; the purchase remains unresolved'; }
      await session.save();
      if (['intent', 'unknown'].includes(acquisition.state) && (acquisition.reconciliationAttempts ?? 0) >= 3) {
        await this.finish(session, 'needs_attention'); return false;
      }
      if (acquisition.state === 'pending') {
        if (!job.outbox.some(e => e.event.type === 'number.pending' && e.event.data.reference === acquisition.reference)) {
          queueEvent(job, 'number.pending', this.now(), { reference: acquisition.reference, acquisition });
          await session.save();
        }
      }
      if (['intent', 'unknown', 'pending'].includes(acquisition.state)) {
        if (this.now() >= Date.parse(job.deadline!) + 600_000 || await session.cancelled()) await this.finish(session, 'needs_attention');
        return false;
      }
    }
    if (acquisition.state === 'owned') {
      if (!this.hasTime()) return false;
      job.phase = 'configuring';
      acquisition.configurationAttempts = (acquisition.configurationAttempts ?? 0) + 1;
      await session.save();
      try { await provider.configure(job.config, acquisition); }
      catch {
        acquisition.error = 'Number configuration failed; this owned number still occupies its quantity slot';
        await session.save();
        if (acquisition.configurationAttempts >= 3) await this.finish(session, 'needs_attention');
        return false;
      }
      acquisition.state = 'configured'; acquisition.error = undefined;
      if (!acquisition.eventQueued) { queueEvent(job, 'number.acquired', this.now(), { acquisition }); acquisition.eventQueued = true; }
      await session.save();
    }
    return ['configured', 'rejected'].includes(acquisition.state);
  }
}

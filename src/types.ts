import type { Capability, Config } from './config.js';
export type { Capability } from './config.js';

export type ProviderType = 'twilio' | 'telnyx';
export interface Price {
  currency: string;
  monthly: string | null;
  oneTime: string | null;
  observedAt: string;
  source: string;
}
export interface Candidate {
  provider: ProviderType;
  phoneNumber: string;
  country: string;
  numberType: string;
  capabilities: Capability[];
  bestEffort?: boolean;
  price?: Price;
}
export interface Acquisition {
  candidate: Candidate;
  reference: string;
  state: 'intent' | 'unknown' | 'pending' | 'owned' | 'configured' | 'rejected';
  resourceId?: string;
  orderId?: string;
  error?: string;
  eventQueued?: boolean;
}
export interface Provider {
  type: ProviderType;
  preflight(config: Config): Promise<string>;
  search(config: Config, areaCode: string, limit: number): Promise<Candidate[]>;
  ownedNumbers(): Promise<string[]>;
  quote(candidate: Candidate): Promise<Price>;
  acquire(config: Config, acquisition: Acquisition): Promise<Acquisition>;
  reconcile(config: Config, acquisition: Acquisition): Promise<Acquisition>;
  configure(config: Config, acquisition: Acquisition): Promise<void>;
}
export interface Event {
  id: string;
  type: string;
  jobId: string;
  jobName: string;
  mode: Config['mode'];
  occurredAt: string;
  data: Record<string, unknown>;
}
export interface Delivery { channelId: string; attempts: number; deliveredAt?: string; error?: string; transport?: string }
export interface OutboxEntry { event: Event; deliveries: Delivery[] }
export interface Job {
  version: 1;
  id: string;
  config: Config;
  fingerprint: string;
  createdAt: string;
  startedAt?: string;
  deadline?: string;
  nextPollAt?: string;
  identities: Partial<Record<ProviderType, string>>;
  disabledProviders: ProviderType[];
  status: 'queued' | 'running' | 'succeeded' | 'expired' | 'cancelled' | 'failed' | 'needs_attention';
  phase: string;
  acquisitions: Acquisition[];
  outbox: OutboxEntry[];
  lastRound?: { observedAt: string; candidates: Candidate[]; errors: string[]; exclusions?: { provider: ProviderType; phoneNumber: string; reason: string }[] };
  error?: string;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export const occupied = (job: Job): Acquisition[] => job.acquisitions.filter(a => a.state !== 'rejected');
export const unresolved = (job: Job): boolean => job.acquisitions.some(a => !['configured', 'rejected'].includes(a.state));
export const progress = (job: Job) => ({
  requested: job.config.quantity,
  configured: job.acquisitions.filter(a => a.state === 'configured').length,
  owned: job.acquisitions.filter(a => ['owned', 'configured'].includes(a.state)).length,
  pending: job.acquisitions.filter(a => a.state === 'pending').length,
  uncertain: job.acquisitions.filter(a => ['intent', 'unknown'].includes(a.state)).length,
  remaining: job.config.quantity - occupied(job).length
});

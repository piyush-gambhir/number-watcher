import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { parseConfig, type Config } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Acquisition, Candidate, Clock, Job, Provider, ProviderType } from '../src/types.js';

export class FakeClock implements Clock {
  time = Date.parse('2026-01-01T00:00:00Z');
  now = () => this.time;
  sleep = async (ms: number) => { this.time += ms; };
}
export const config = (overrides: Record<string, unknown> = {}): Config => parseConfig({
  version: 1, name: 'Test request', mode: 'purchase', areaCodes: ['210'], requiredCapabilities: ['voice', 'sms'], quantity: 1,
  providers: [
    { type: 'twilio', accountSid: `AC${'0'.repeat(32)}`, apiKeySidEnv: 'TWILIO_KEY', apiKeySecretEnv: 'TWILIO_SECRET',
      purchase: { voiceUrl: 'https://example.com/voice', smsUrl: 'https://example.com/sms', messagingServiceSid: `MG${'0'.repeat(32)}` } },
    { type: 'telnyx', apiKeyEnv: 'TELNYX_KEY', purchase: { connectionId: '123', expectedVoiceWebhookUrl: 'https://example.com/voice',
      messagingProfileId: '00000000-0000-4000-8000-000000000000', expectedSmsWebhookUrl: 'https://example.com/sms' } }
  ], budget: { currency: 'USD', maxMonthlyPerNumber: '3.00' }, ...overrides
});
export const channels = { channels: [{ id: 'hook', type: 'webhook', webhookUrlEnv: 'HOOK', webhookSecretEnv: 'SECRET' }] };
export const candidate = (provider: ProviderType = 'twilio', phoneNumber = '+12105550101'): Candidate => ({
  provider, phoneNumber, country: 'US', numberType: 'local', capabilities: ['voice', 'sms'],
  price: { currency: 'USD', monthly: '2.00', oneTime: '0.00', source: 'test', observedAt: '2026-01-01T00:00:00Z' }
});
export class FakeProvider implements Provider {
  constructor(readonly type: ProviderType, numbers: Candidate[] = []) {
    this.search.mockResolvedValue(numbers);
  }
  preflight = vi.fn(async (_config: Config) => `${this.type}-identity`);
  search = vi.fn(async (_config: Config, _area: string, _limit: number): Promise<Candidate[]> => []);
  ownedNumbers = vi.fn(async (): Promise<string[]> => []);
  quote = vi.fn(async (number: Candidate) => number.price!);
  acquire = vi.fn(async (_config: Config, acquisition: Acquisition): Promise<Acquisition> => ({ ...acquisition, state: 'owned', resourceId: 'number-1' }));
  reconcile = vi.fn(async (_config: Config, acquisition: Acquisition): Promise<Acquisition> => ({ ...acquisition, state: 'unknown' }));
  configure = vi.fn(async (_config: Config, _acquisition: Acquisition): Promise<void> => {});
}
export const acknowledged = { async deliver(job: Job, save: () => Promise<void>) {
  for (const entry of job.outbox) for (const delivery of entry.deliveries) delivery.deliveredAt = new Date().toISOString();
  await save();
} };
export async function fixtureStore(): Promise<{ store: Store; clean: () => Promise<void> }> {
  const root = await mkdtemp(join(process.cwd(), '.test-state-'));
  return { store: new Store(root), clean: () => rm(root, { recursive: true, force: true }) };
}

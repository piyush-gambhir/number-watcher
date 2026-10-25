import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { configSchema, parseConfig } from '../src/config.js';
import { decimal, selectCandidates, withinBudget } from '../src/matching.js';
import { candidate, channels, config } from './helpers.js';

describe('request validation and matching', () => {
  it.each(['notify', 'purchase'])('accepts the documented %s example', async name => {
    expect(configSchema.safeParse(JSON.parse(await readFile(`examples/${name}.json`, 'utf8'))).success).toBe(true);
  });
  it.each([
    { areaCodes: [] }, { areaCodes: ['210', '210'] }, { areaCodes: ['110'] }, { quantity: 0 }, { quantity: 1.5 },
    { mode: 'automatic' }, { requiredCapabilities: ['mms'] }, { mode: 'notify' }, { budget: undefined }, { typo: 'value' }
  ])('rejects unsafe or incomplete input: %j', override => {
    expect(() => config(override)).toThrow();
  });
  it('requires provider routes only for purchase and selected capabilities', () => {
    const provider = { type: 'twilio', accountSid: `AC${'0'.repeat(32)}`, apiKeySidEnv: 'KEY', apiKeySecretEnv: 'SECRET' };
    expect(() => config({ mode: 'notify', notifications: channels, providers: [provider] })).not.toThrow();
    expect(() => config({ providers: [provider] })).toThrow();
    expect(() => config({ requiredCapabilities: ['voice'], providers: [{ ...provider, purchase: { voiceUrl: 'https://example.com/voice' } }] })).not.toThrow();
  });
  it('rejects duplicate channel IDs and conflicting provider entries', () => {
    expect(() => config({ notifications: { channels: [channels.channels[0], channels.channels[0]] } })).toThrow();
    const cfg = config();
    expect(() => parseConfig({ ...cfg, providers: [cfg.providers[0], cfg.providers[0]] })).toThrow();
  });
  it('requires unambiguous sender and recipient sources for email', () => {
    const base = { id: 'email', type: 'email', fromEnv: 'FROM', toEnv: 'TO' };
    expect(() => config({ notifications: { channels: [base] } })).not.toThrow();
    for (const channel of [
      { ...base, from: 'numbers@example.com' }, { ...base, to: ['ops@example.com'] },
      { ...base, fromEnv: undefined }, { ...base, toEnv: undefined }
    ]) expect(() => config({ notifications: { channels: [channel] } })).toThrow('Email requires exactly one');
  });
  it('uses exact decimal boundaries and rejects unknown or over-precision prices', () => {
    const cfg = config({ budget: { currency: 'USD', maxMonthlyPerNumber: '0.3000', maxOneTimeFeePerNumber: '0' } });
    const price = { ...candidate().price!, monthly: '0.3000' };
    expect(withinBudget(cfg, price)).toBe(true);
    expect(withinBudget(cfg, { ...price, monthly: '0.3001' })).toBe(false);
    expect(withinBudget(cfg, { ...price, monthly: null })).toBe(false);
    expect(withinBudget(cfg, { ...price, oneTime: null })).toBe(false);
    expect(withinBudget(cfg, { ...price, currency: 'EUR' })).toBe(false);
    expect(withinBudget(cfg, { ...price, monthly: '0.00001' })).toBe(false);
    expect(decimal('0.1') + decimal('0.2')).toBe(decimal('0.3'));
  });
  it('enforces area before provider, deduplicates E.164, and rejects weak matches', () => {
    const cfg = config({ areaCodes: ['210', '726'] });
    const numbers = [candidate('twilio', '+17265550101'), candidate('telnyx'), candidate('twilio'),
      { ...candidate('telnyx', '+12105550102'), bestEffort: true },
      candidate('twilio', '+15125550103'), { ...candidate('twilio', '+12105550104'), capabilities: ['voice'] as const }];
    expect(selectCandidates(cfg, numbers as ReturnType<typeof candidate>[]).map(n => [n.provider, n.phoneNumber]))
      .toEqual([['twilio', '+12105550101'], ['twilio', '+17265550101']]);
    expect(selectCandidates(cfg, [candidate()], new Set(['+12105550101']))).toEqual([]);
  });
});

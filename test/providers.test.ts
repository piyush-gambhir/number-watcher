import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Runner } from '../src/engine.js';
import { Http } from '../src/http.js';
import { Notifications } from '../src/notifications/index.js';
import { createProviders } from '../src/providers/index.js';
import { Telnyx } from '../src/providers/telnyx.js';
import { Twilio } from '../src/providers/twilio.js';
import type { Store } from '../src/store.js';
import type { ProviderConfig } from '../src/config.js';
import { candidate, channels, config, FakeClock, fixtureStore } from './helpers.js';

const env = { TWILIO_KEY: 'key', TWILIO_SECRET: 'secret', TELNYX_KEY: 'telnyx-key', HOOK: 'https://notify.example.com/event', SECRET: 'signing-key' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('provider API contracts', () => {
  const cfg = config();
  it('normalizes Twilio REST SMS/MMS capability keys without dropping valid inventory', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ available_phone_numbers: [
      { phone_number: '+12105550101', iso_country: 'US', capabilities: { voice: true, SMS: true, MMS: true } },
      { phone_number: '+12105550102', iso_country: 'US', capabilities: { voice: true, SMS: false, MMS: false } }
    ] }));
    const provider = new Twilio(cfg.providers[0] as Extract<ProviderConfig, { type: 'twilio' }>, env, new Http(fetch));
    const found = await provider.search(cfg, '210', 2);
    expect(found[0].capabilities).toEqual(['voice', 'sms', 'mms']);
    expect(found[1].capabilities).toEqual(['voice']);
  });
  it('uses AND capability filters and exact area-code filters on both providers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.hostname === 'api.twilio.com') return json({ available_phone_numbers: [] });
      return json({ data: [] });
    });
    const providers = createProviders(cfg, env, new Http(fetch, new FakeClock()));
    for (const provider of providers) await provider.search(cfg, '210', 2);
    const twilio = new URL(String(fetch.mock.calls[0][0]));
    expect(twilio.searchParams.get('AreaCode')).toBe('210');
    expect(twilio.searchParams.get('VoiceEnabled')).toBe('true');
    expect(twilio.searchParams.get('SmsEnabled')).toBe('true');
    const telnyx = new URL(String(fetch.mock.calls[1][0]));
    expect(telnyx.searchParams.get('filter[national_destination_code]')).toBe('210');
    expect(telnyx.searchParams.getAll('filter[features][]')).toEqual(['voice', 'sms']);
    expect(telnyx.searchParams.get('filter[best_effort]')).toBe('false');
    expect(fetch.mock.calls.every(c => (c[1]?.method ?? 'GET') === 'GET')).toBe(true);
  });
  it('does not automatically retry Twilio purchase writes after HTTP 500', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ code: 20500 }, 500));
    const provider = new Twilio(cfg.providers[0] as Extract<ProviderConfig, { type: 'twilio' }>, env, new Http(fetch));
    const result = await provider.acquire(cfg, { candidate: candidate(), reference: 'job-marker', state: 'intent' });
    expect(result.state).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats explicit Twilio unavailability as rejected without retrying', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ code: 21422 }, 400));
    const provider = new Twilio(cfg.providers[0] as Extract<ProviderConfig, { type: 'twilio' }>, env, new Http(fetch));
    expect((await provider.acquire(cfg, { candidate: candidate(), reference: 'job-marker', state: 'intent' })).state).toBe('rejected');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not claim an unrelated owned Twilio number after a timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ incoming_phone_numbers: [{
      sid: 'PN-other', phone_number: '+12105550101', friendly_name: 'another-job', account_sid: cfg.providers[0].type === 'twilio' && cfg.providers[0].accountSid
    }] }));
    const provider = new Twilio(cfg.providers[0] as Extract<ProviderConfig, { type: 'twilio' }>, env, new Http(fetch));
    expect((await provider.reconcile(cfg, { candidate: candidate(), reference: 'this-job', state: 'unknown' })).state).toBe('unknown');
  });
  it('rejects shared Twilio routing mismatches without changing service settings', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => String(input).includes('messaging.twilio.com')
      ? json({ account_sid: `AC${'0'.repeat(32)}`, use_inbound_webhook_on_number: false, inbound_request_url: 'https://wrong.example.com', inbound_method: 'POST' })
      : json({ sid: `AC${'0'.repeat(32)}`, status: 'active' }));
    const provider = new Twilio(cfg.providers[0] as Extract<ProviderConfig, { type: 'twilio' }>, env, new Http(fetch));
    await expect(provider.preflight(cfg)).rejects.toThrow('overrides');
    expect(fetch.mock.calls.every(c => c[1]?.method === 'GET')).toBe(true);
  });
  it('pins Telnyx credentials across resume and rejects mismatched order references', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => String(input).endsWith('/balance')
      ? json({ data: { balance: '10.00' } }) : json({ data: { id: 'order-1', customer_reference: 'other-job', phone_numbers: [{ phone_number: '+12105550101' }], status: 'success' } }));
    const entry = cfg.providers[1] as Extract<ProviderConfig, { type: 'telnyx' }>;
    const provider = new Telnyx(entry, env, new Http(fetch));
    const other = new Telnyx(entry, { ...env, TELNYX_KEY: 'different-key' }, new Http(fetch));
    const notify = config({ mode: 'notify', notifications: channels });
    expect(await provider.preflight(notify)).not.toBe(await other.preflight(notify));
    expect((await provider.reconcile(cfg, { candidate: candidate('telnyx'), reference: 'this-job', state: 'pending', orderId: 'order-1' })).state).toBe('unknown');
  });
  it('uses digits-only Telnyx ownership filters and does not treat a pending order as rejected', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname.includes('/number_orders/')) return json({ data: { id: 'order-1', customer_reference: 'this-job', phone_numbers: [{ phone_number: '+12105550101' }], status: 'pending' } });
      expect(url.searchParams.get('filter[phone_number]')).toBe('12105550101');
      return json({ data: [], meta: { total_pages: 1 } });
    });
    const provider = new Telnyx(cfg.providers[1] as Extract<ProviderConfig, { type: 'telnyx' }>, env, new Http(fetch));
    expect((await provider.reconcile(cfg, { candidate: candidate('telnyx'), reference: 'this-job', state: 'pending', orderId: 'order-1' })).state).toBe('pending');
  });
});

describe('worker through real adapters, persisted state, and notification transport', () => {
  let store: Store;
  let clean: () => Promise<void>;
  beforeEach(async () => { ({ store, clean } = await fixtureStore()); });
  afterEach(async () => { await clean(); });
  it.each(['normal', 'purchase-response-lost'])('completes a two-provider request: %s', async scenario => {
    const cfg = config({ quantity: 2, notifications: channels });
    const clock = new FakeClock();
    let twilioOwned: Record<string, unknown> | undefined;
    let attached = false;
    let telnyxOrder: Record<string, unknown> | undefined;
    const notifications: Record<string, unknown>[] = [];
    let purchases = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      const method = options?.method ?? 'GET';
      if (url.hostname === 'notify.example.com') { notifications.push(JSON.parse(options?.body as string)); return new Response('ok'); }
      if (url.hostname === 'pricing.twilio.com') return json({ price_unit: 'usd', phone_number_prices: [{ number_type: 'local', current_price: '2.0000' }] });
      if (url.hostname === 'messaging.twilio.com') {
        if (url.pathname.endsWith('/PhoneNumbers') && method === 'GET') return json({ phone_numbers: [] });
        if (url.pathname.endsWith('/PhoneNumbers') && method === 'POST') { attached = true; return json({ sid: 'PN-owned' }); }
        if (url.pathname.endsWith('/PhoneNumbers/PN-owned')) return attached
          ? json({ sid: 'PN-owned', service_sid: `MG${'0'.repeat(32)}` }) : json({ code: 20404 }, 404);
        return json({ account_sid: `AC${'0'.repeat(32)}`, use_inbound_webhook_on_number: true });
      }
      if (url.hostname === 'api.twilio.com') {
        if (url.pathname.includes('/AvailablePhoneNumbers/')) return json({ available_phone_numbers: [{ phone_number: '+12105550101', iso_country: 'US', capabilities: { voice: true, SMS: true, MMS: true } }] });
        if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) {
          if (method === 'GET') return json({ incoming_phone_numbers: twilioOwned ? [twilioOwned] : [] });
          purchases++;
          const fields = new URLSearchParams(options?.body as string);
          twilioOwned = { sid: 'PN-owned', account_sid: `AC${'0'.repeat(32)}`, phone_number: fields.get('PhoneNumber'), friendly_name: fields.get('FriendlyName'),
            voice_url: fields.get('VoiceUrl'), voice_method: fields.get('VoiceMethod'), sms_url: fields.get('SmsUrl'), sms_method: fields.get('SmsMethod') };
          if (scenario === 'purchase-response-lost') throw new Error('Socket closed after purchase accepted');
          return json(twilioOwned);
        }
        if (url.pathname.includes('/IncomingPhoneNumbers/')) return json(twilioOwned);
        return json({ sid: `AC${'0'.repeat(32)}`, status: 'active' });
      }
      if (url.pathname.endsWith('/balance')) return json({ data: { balance: '10.00' } });
      if (url.pathname.includes('/call_control_applications/')) return json({ data: { id: '123', active: true, webhook_event_url: 'https://example.com/voice' } });
      if (url.pathname.includes('/messaging_profiles/')) return json({ data: { id: '00000000-0000-4000-8000-000000000000', enabled: true, webhook_url: 'https://example.com/sms' } });
      if (url.pathname.endsWith('/available_phone_numbers')) return json({ data: [{ phone_number: '+12105550102', best_effort: false,
        region_information: [{ region_type: 'country_code', region_name: 'US' }], features: [{ name: 'voice' }, { name: 'sms' }], cost_information: { currency: 'USD', monthly_cost: '1.00', upfront_cost: '0.00' } }] });
      if (url.pathname.endsWith('/number_orders') && method === 'POST') {
        purchases++;
        telnyxOrder = { ...JSON.parse(options?.body as string), id: 'order-1', status: 'success' };
        return json({ data: telnyxOrder });
      }
      if (url.pathname.endsWith('/number_orders/order-1')) return json({ data: telnyxOrder });
      if (url.pathname.endsWith('/phone_numbers')) return json({ data: telnyxOrder ? [{ id: 'telnyx-owned', phone_number: '+12105550102', status: 'active' }] : [], meta: { total_pages: 1 } });
      if (url.pathname.endsWith('/phone_numbers/telnyx-owned')) return json({ data: { id: 'telnyx-owned', phone_number: '+12105550102', status: 'active', connection_id: '123' } });
      if (url.pathname.endsWith('/phone_numbers/telnyx-owned/messaging')) return json({ data: { messaging_profile_id: '00000000-0000-4000-8000-000000000000' } });
      throw new Error(`Unexpected test request: ${method} ${url.pathname}`);
    });
    const http = new Http(fetch, clock);
    const runner = new Runner(store, { clock, providers: c => createProviders(c, env, http), notifications: c => new Notifications(c, env, fetch, clock) });
    const job = await store.add(cfg);
    const result = await runner.run(job.id);
    expect(result.status).toBe('succeeded');
    expect(purchases).toBe(2);
    expect(attached).toBe(true);
    expect(notifications.filter(e => e.type === 'number.acquired')).toHaveLength(2);
    expect(notifications.filter(e => e.type === 'job.completed')).toHaveLength(1);
    expect((await store.load(job.id)).acquisitions.every(a => a.state === 'configured')).toBe(true);
    const saved = JSON.stringify(await store.load(job.id));
    expect(saved).not.toContain('telnyx-key');
    expect(saved).not.toContain('https://notify.example.com');
    expect(saved).not.toContain('signing-key');
    await runner.run(job.id);
    expect(purchases).toBe(2);
  });
});

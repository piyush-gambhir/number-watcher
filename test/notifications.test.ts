import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createEmailProvider, ResendEmail, SmtpEmail } from '../src/notifications/email.js';
import { createSender, Notifications } from '../src/notifications/index.js';
import { queueEvent, Runner } from '../src/engine.js';
import type { Store } from '../src/store.js';
import type { Event } from '../src/types.js';
import { candidate, channels, config, FakeClock, FakeProvider, fixtureStore } from './helpers.js';

const event: Event = { id: 'event-1', type: 'availability.found', jobId: 'job-1', jobName: 'Request', mode: 'notify',
  occurredAt: '2026-01-01T00:00:00Z', data: { candidates: [candidate()] } };
const message = { id: 'event-1-email', from: 'numbers@example.com', to: ['ops@example.com'], subject: 'Numbers found', text: 'One number available' };

describe('channel and email provider adapters', () => {
  it('sends Slack-compatible messages to its incoming webhook', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const sender = createSender({ id: 'slack', type: 'slack', webhookUrlEnv: 'SLACK' }, { SLACK: 'https://hooks.slack.com/services/test/channel/secret' }, fetch);
    await sender.send(event);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(body.text).toContain('+12105550101');
    expect(body.text).toContain('event-1');
    expect(body.parse).toBe('none');
    expect(body).not.toHaveProperty('data');
  });
  it('signs the exact generic webhook payload with timestamp and stable event ID', async () => {
    const clock = new FakeClock();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'));
    const sender = createSender({ id: 'hook', type: 'webhook', webhookUrlEnv: 'URL', webhookSecretEnv: 'KEY' }, { URL: 'https://example.com/hook', KEY: 'signing-secret' }, fetch, clock);
    await sender.send(event);
    const request = fetch.mock.calls[0][1]!;
    const timestamp = String(Math.floor(clock.now() / 1000));
    expect(request.headers).toMatchObject({ 'X-Number-Watcher-Timestamp': timestamp,
      'X-Number-Watcher-Signature': createHmac('sha256', 'signing-secret').update(`${timestamp}.${request.body}`).digest('hex') });
    expect(JSON.parse(request.body as string).id).toBe(event.id);
  });
  it('selects the configured email provider in one module with no send-time fallback', () => {
    expect(createEmailProvider('auto', { RESEND_API_KEY: 'key', SMTP_URL: 'smtps://user:pass@smtp.example.com' }).type).toBe('resend');
    expect(createEmailProvider('auto', { SMTP_URL: 'smtp://user:pass@smtp.example.com:587' }).type).toBe('smtp');
    expect(createEmailProvider('smtp', { RESEND_API_KEY: 'key', SMTP_URL: 'smtps://user:pass@smtp.example.com' }).type).toBe('smtp');
    expect(() => createEmailProvider('auto', {})).toThrow('Email requires');
    expect(() => createEmailProvider('smtp', { SMTP_URL: 'smtp://host?tls.rejectUnauthorized=false' })).toThrow();
  });
  it('passes provider-independent messages through SMTP with a stable Message-ID', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: message.to, rejected: [] });
    await new SmtpEmail({ sendMail }).send(message);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ messageId: '<event-1-email@number-watcher.local>', to: message.to, text: message.text }));
  });
  it('treats partial SMTP recipient acceptance as incomplete delivery', async () => {
    await expect(new SmtpEmail({ sendMail: async () => ({ accepted: [], rejected: ['ops@example.com'] }) }).send(message)).rejects.toThrow('all recipients');
  });
  it('uses Resend idempotency keys without exposing API keys in messages', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'email-id' })));
    await new ResendEmail('secret-key', fetch).send(message);
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ 'Idempotency-Key': message.id, Authorization: 'Bearer secret-key' });
    expect(fetch.mock.calls[0][1]!.body).not.toContain('secret-key');
  });
  it('does not hide a failed email-provider response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(new ResendEmail('secret', fetch).send(message)).rejects.toThrow('HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('durable independent notification deliveries', () => {
  let store: Store;
  let clean: () => Promise<void>;
  let clock: FakeClock;
  beforeEach(async () => { ({ store, clean } = await fixtureStore()); clock = new FakeClock(); });
  afterEach(async () => { await clean(); });
  it('retries only failed channels and never repeats acknowledged Slack delivery', async () => {
    const cfg = config({ notifications: { channels: [
      { id: 'slack', type: 'slack', webhookUrlEnv: 'SLACK' },
      { id: 'email', type: 'email', from: 'numbers@example.com', to: ['ops@example.com'], provider: 'resend' }
    ] } });
    const slack = vi.fn().mockResolvedValue(undefined);
    const email = vi.fn().mockRejectedValue(new Error('provider down with secret data'));
    const notifier = new Notifications(cfg, {}, globalThis.fetch, clock,
      channel => ({ transport: channel.type, send: channel.id === 'slack' ? slack : email }));
    const job = await store.add(cfg);
    queueEvent(job, 'availability.found', clock.now(), { candidates: [candidate()] });
    await store.save(job);
    await notifier.deliver(job, () => store.save(job));
    expect(slack).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await store.load(job.id))).not.toContain('secret data');
    email.mockResolvedValue(undefined);
    await notifier.deliver(job, () => store.save(job), true);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(4);
    expect(job.outbox[0].deliveries.every(d => d.deliveredAt)).toBe(true);
    expect(email.mock.calls.every(call => call[0].id === job.outbox[0].event.id)).toBe(true);
  });
  it('does not poll or buy again after failed availability delivery; retry finishes the same request', async () => {
    const cfg = config({ mode: 'notify', notifications: channels });
    const provider = new FakeProvider('twilio', [candidate()]);
    let fail = true;
    const send = vi.fn(async () => { if (fail) throw new Error('Unavailable'); });
    const notifier = new Notifications(cfg, {}, globalThis.fetch, clock, () => ({ transport: 'webhook', send }));
    const job = await store.add(cfg);
    const runner = new Runner(store, { clock, providers: () => [provider], notifications: () => notifier });
    const partial = await runner.run(job.id);
    expect(partial.status).toBe('needs_attention');
    const id = partial.outbox.find(e => e.event.type === 'availability.found')!.event.id;
    fail = false;
    const result = await runner.retryNotifications(job.id);
    expect(result.status).toBe('succeeded');
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.acquire).not.toHaveBeenCalled();
    expect(result.outbox.find(e => e.event.type === 'availability.found')!.event.id).toBe(id);
  });
  it('keeps successful purchases successful even when every notification fails', async () => {
    const cfg = config({ notifications: channels });
    const provider = new FakeProvider('twilio', [candidate()]);
    const notifier = new Notifications(cfg, {}, globalThis.fetch, clock, () => ({ transport: 'webhook', send: async () => { throw new Error('down'); } }));
    const job = await store.add(cfg);
    const runner = new Runner(store, { clock, providers: () => [provider], notifications: () => notifier });
    const result = await runner.run(job.id);
    expect(result.status).toBe('succeeded');
    expect(result.outbox.some(e => e.deliveries.some(d => !d.deliveredAt))).toBe(true);
    expect(provider.acquire).toHaveBeenCalledTimes(1);
  });
});

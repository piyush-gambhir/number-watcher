import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { secret, type Channel, type Config, type Env } from '../config.js';
import type { Fetch } from '../http.js';
import type { Clock, Event, Job } from '../types.js';
import { systemClock } from '../types.js';
import { createEmailProvider, type EmailProvider } from './email.js';

export interface Sender { readonly transport: string; send(event: Event): Promise<void> }

export function renderEvent(event: Event): string {
  const lines = [`${event.type}: ${event.jobName}`, `Job: ${event.jobId}`, `Event: ${event.id}`, `Observed: ${event.occurredAt}`];
  const counts = event.data.progress as Record<string, number> | undefined;
  if (counts) lines.push(`Requested: ${counts.requested}; configured: ${counts.configured}; pending: ${counts.pending}; uncertain: ${counts.uncertain}`);
  const numbers = event.data.candidates ?? event.data.acquisitions ?? (event.data.acquisition ? [event.data.acquisition] : []);
  if (Array.isArray(numbers)) for (const item of numbers) {
    const number = item.candidate ?? item;
    lines.push(`${number.provider}: ${number.phoneNumber}${item.state ? ` (${item.state})` : ''}${number.price?.monthly ? `, ${number.price.currency} ${number.price.monthly}/month` : ''}`);
  }
  if (event.type === 'availability.found') lines.push('Availability was observed at this time; numbers are not reserved.');
  if (event.data.provider) lines.push(`Provider: ${String(event.data.provider)}`);
  if (event.data.error) lines.push(`Error: ${String(event.data.error)}`);
  return lines.join('\n');
}
function destination(env: Env, key: string, slack = false): string {
  const url = new URL(secret(env, key));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Invalid HTTPS notification destination: ${key}`);
  if (slack && (!['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) || !url.pathname.startsWith('/services/'))) throw new Error('Slack requires an incoming webhook URL');
  return url.toString();
}
export function createSender(channel: Channel, env: Env, fetch: Fetch = globalThis.fetch, clock: Clock = systemClock,
  emailFactory: typeof createEmailProvider = createEmailProvider): Sender {
  if (channel.type === 'email') {
    const from = channel.fromEnv ? secret(env, channel.fromEnv).trim() : channel.from;
    const to = channel.toEnv ? secret(env, channel.toEnv).split(',').map(value => value.trim()) : channel.to;
    const addresses = z.object({ from: z.string().email(), to: z.array(z.string().email()).min(1).max(20) }).safeParse({ from, to });
    if (!addresses.success) throw new Error(`Invalid email sender or recipients for notification channel ${channel.id}`);
    const email: EmailProvider = emailFactory(channel.provider, env, fetch);
    return { transport: `email:${email.type}`, send: event => email.send({
      id: `${event.id}-${channel.id}`, from: addresses.data.from, to: addresses.data.to,
      subject: `[Number Watcher] ${event.type}: ${event.jobName}`.replace(/[\r\n]/g, ' '), text: renderEvent(event)
    }) };
  }
  const url = destination(env, channel.webhookUrlEnv, channel.type === 'slack');
  const signingSecret = channel.type === 'webhook' ? secret(env, channel.webhookSecretEnv) : undefined;
  return { transport: channel.type, async send(event) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const text = renderEvent(event);
    const body = channel.type === 'slack' ? JSON.stringify({
      text: text.slice(0, 39000), parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false
    }) : JSON.stringify(event);
    if (signingSecret) {
      const timestamp = String(Math.floor(clock.now() / 1000));
      headers['X-Number-Watcher-Timestamp'] = timestamp;
      headers['X-Number-Watcher-Signature'] = createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex');
    }
    const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Notification rejected (HTTP ${response.status})`);
  } };
}

export class Notifications {
  readonly senders = new Map<string, Sender>();
  constructor(config: Config, env: Env = process.env, fetch: Fetch = globalThis.fetch,
    readonly clock: Clock = systemClock, factory: typeof createSender = createSender,
    readonly attemptsPerInvocation = 3) {
    for (const channel of config.notifications?.channels ?? []) this.senders.set(channel.id, factory(channel, env, fetch, clock));
  }
  async deliver(job: Job, save: () => Promise<void>, retry = false, until = Infinity): Promise<void> {
    for (const entry of job.outbox) {
      for (const delivery of entry.deliveries) {
        if (delivery.deliveredAt) continue;
        const sender = this.senders.get(delivery.channelId);
        if (!sender) throw new Error('Notification channel missing from saved configuration');
        if (delivery.transport && delivery.transport !== sender.transport) throw new Error('Email provider changed for an unfinished delivery; restore its original provider');
        if (retry) delivery.attempts = 0;
        delivery.transport = sender.transport;
        let attempted = 0;
        while (delivery.attempts < 3 && attempted < this.attemptsPerInvocation && this.clock.now() < until) {
          const delay = this.attemptsPerInvocation === 1 ? 0 : [0, 5000, 30000][delivery.attempts];
          if (this.clock.now() + delay >= until) break;
          if (delay) await this.clock.sleep(delay);
          delivery.attempts++;
          attempted++;
          await save();
          try { await sender.send(entry.event); }
          catch {
            delivery.error = `${sender.transport} delivery failed; check destination, credentials, and provider status`;
            await save();
            continue;
          }
          delivery.deliveredAt = new Date(this.clock.now()).toISOString();
          delivery.error = undefined;
          await save();
          break;
        }
      }
    }
  }
}
export const delivered = (job: Job, type: string) => job.outbox.filter(e => e.event.type === type).every(e => e.deliveries.every(d => !!d.deliveredAt));

import nodemailer from 'nodemailer';
import { secret, type Env } from '../config.js';
import type { Fetch } from '../http.js';

export interface EmailMessage { id: string; from: string; to: string[]; subject: string; text: string }
export interface EmailProvider { readonly type: 'smtp' | 'resend'; send(message: EmailMessage): Promise<void> }
export interface SmtpSender { sendMail(message: Record<string, unknown>): Promise<{ accepted?: unknown[]; rejected?: unknown[] }> }

export class SmtpEmail implements EmailProvider {
  readonly type = 'smtp' as const;
  constructor(readonly transport: SmtpSender) {}
  async send(message: EmailMessage): Promise<void> {
    const result = await this.transport.sendMail({
      from: message.from, to: message.to, subject: message.subject, text: message.text,
      messageId: `<${message.id}@number-watcher.local>`, disableFileAccess: true, disableUrlAccess: true
    });
    if (result.rejected?.length || result.accepted?.length !== message.to.length) throw new Error('SMTP did not accept all recipients');
  }
}
export class ResendEmail implements EmailProvider {
  readonly type = 'resend' as const;
  constructor(readonly apiKey: string, readonly fetch: Fetch = globalThis.fetch) {}
  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': message.id },
      body: JSON.stringify({ from: message.from, to: message.to, subject: message.subject, text: message.text })
    });
    if (!response.ok) throw new Error(`Resend delivery failed (HTTP ${response.status})`);
    const result = await response.json() as { id?: string };
    if (!result.id) throw new Error('Resend did not acknowledge an email ID');
  }
}

export function createEmailProvider(requested: 'auto' | 'smtp' | 'resend', env: Env, fetch: Fetch = globalThis.fetch): EmailProvider {
  const setting = requested === 'auto' ? env.NUMBER_WATCHER_EMAIL_PROVIDER ?? 'auto' : requested;
  if (!['auto', 'smtp', 'resend'].includes(setting)) throw new Error('Invalid NUMBER_WATCHER_EMAIL_PROVIDER');
  const type = setting === 'auto' ? (env.RESEND_API_KEY ? 'resend' : env.SMTP_URL ? 'smtp' : undefined) : setting;
  if (type === 'resend') return new ResendEmail(secret(env, 'RESEND_API_KEY'), fetch);
  if (type === 'smtp') {
    const url = new URL(secret(env, 'SMTP_URL'));
    if (!['smtp:', 'smtps:'].includes(url.protocol) || url.search) throw new Error('SMTP_URL must use smtp/smtps without query options');
    const transport = nodemailer.createTransport({
      host: url.hostname, port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
      secure: url.protocol === 'smtps:', requireTLS: url.protocol === 'smtp:',
      auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000,
      disableFileAccess: true, disableUrlAccess: true
    });
    return new SmtpEmail(transport);
  }
  throw new Error('Email requires RESEND_API_KEY or SMTP_URL');
}

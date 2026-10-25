import { z } from 'zod';
import { readFile } from 'node:fs/promises';

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Expected an HTTPS URL without embedded credentials');
const money = z.string().regex(/^\d+(\.\d{1,4})?$/);
const twilio = z.object({
  type: z.literal('twilio'),
  accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  apiKeySidEnv: envName,
  apiKeySecretEnv: envName,
  purchase: z.object({
    voiceUrl: httpsUrl.optional(), smsUrl: httpsUrl.optional(),
    messagingServiceSid: z.string().regex(/^MG[0-9a-fA-F]{32}$/).optional()
  }).strict().optional()
}).strict();
const telnyx = z.object({
  type: z.literal('telnyx'), apiKeyEnv: envName,
  purchase: z.object({
    connectionId: z.string().regex(/^\d+$/).optional(),
    expectedVoiceWebhookUrl: httpsUrl.optional(),
    messagingProfileId: z.string().uuid().optional(),
    expectedSmsWebhookUrl: httpsUrl.optional()
  }).strict().optional()
}).strict();
const channel = z.discriminatedUnion('type', [
  z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), type: z.literal('slack'), webhookUrlEnv: envName }).strict(),
  z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), type: z.literal('webhook'), webhookUrlEnv: envName, webhookSecretEnv: envName }).strict(),
  z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), type: z.literal('email'),
    provider: z.enum(['auto', 'smtp', 'resend']).default('auto'),
    from: z.string().email(), to: z.array(z.string().email()).min(1).max(20)
  }).strict()
]);

export const configSchema = z.object({
  version: z.literal(1), name: z.string().trim().min(1).max(80),
  mode: z.enum(['notify', 'purchase']), country: z.literal('US').default('US'),
  numberType: z.literal('local').default('local'),
  areaCodes: z.array(z.string().regex(/^[2-9]\d{2}$/)).min(1).max(20),
  requiredCapabilities: z.array(z.enum(['voice', 'sms', 'mms'])).min(1),
  quantity: z.number().int().min(1).max(100),
  pollIntervalSeconds: z.number().int().min(300).max(3600).default(300),
  durationHours: z.number().int().min(1).max(24).default(24),
  providers: z.array(z.discriminatedUnion('type', [twilio, telnyx])).min(1).max(2),
  budget: z.object({ currency: z.literal('USD'), maxMonthlyPerNumber: money, maxOneTimeFeePerNumber: money.optional() }).strict().optional(),
  notifications: z.object({ channels: z.array(channel).min(1) }).strict().optional()
}).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  for (const [label, values] of [
    ['areaCodes', config.areaCodes], ['requiredCapabilities', config.requiredCapabilities],
    ['providers', config.providers.map(p => p.type)],
    ['notification channel IDs', config.notifications?.channels.map(c => c.id) ?? []]
  ] as const) if (new Set(values).size !== values.length) issue(`Duplicate ${label}`);
  if (config.requiredCapabilities.includes('mms') && !config.requiredCapabilities.includes('sms')) issue('MMS requires SMS');
  if (config.mode === 'notify' && !config.notifications) issue('Notify mode requires at least one notification channel');
  if (config.mode !== 'purchase') return;
  if (!config.budget) issue('Purchase mode requires a monthly price ceiling');
  const voice = config.requiredCapabilities.includes('voice');
  const sms = config.requiredCapabilities.includes('sms');
  for (const p of config.providers) {
    if (p.type === 'twilio') {
      if (voice && !p.purchase?.voiceUrl) issue('Twilio voiceUrl is required');
      if (sms && (!p.purchase?.smsUrl || !p.purchase.messagingServiceSid)) issue('Twilio smsUrl and messagingServiceSid are required');
    } else {
      if (voice && (!p.purchase?.connectionId || !p.purchase.expectedVoiceWebhookUrl)) issue('Telnyx voice connection and expected webhook are required');
      if (sms && (!p.purchase?.messagingProfileId || !p.purchase.expectedSmsWebhookUrl)) issue('Telnyx messaging profile and expected webhook are required');
    }
  }
});

export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = Config['providers'][number];
export type Channel = z.infer<typeof channel>;
export type Capability = Config['requiredCapabilities'][number];
export type Env = Record<string, string | undefined>;
export const parseConfig = (input: unknown): Config => configSchema.parse(input);
export const readConfig = async (path: string): Promise<Config> => parseConfig(JSON.parse(await readFile(path, 'utf8')));
export function secret(env: Env, key: string): string {
  const value = env[key];
  if (!value?.trim()) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

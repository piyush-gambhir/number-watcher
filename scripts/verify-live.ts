import { Command } from 'commander';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { parseConfig, type Env, type ProviderConfig } from '../src/config.js';
import { Runner, searchRound } from '../src/engine.js';
import { Http, type Fetch } from '../src/http.js';
import { Notifications } from '../src/notifications/index.js';
import { createProviders } from '../src/providers/index.js';
import { Store } from '../src/store.js';
import { progress } from '../src/types.js';

const options = new Command()
  .description('Read-only provider checks and a bounded notify workflow with locally captured notifications')
  .requiredOption('--env-file <path>', 'Explicit credential source; values are never copied or printed')
  .option('--providers <list>', 'Comma-separated provider names', 'twilio,telnyx')
  .option('--area-codes <list>', 'Comma-separated US area codes', '210,726')
  .option('--max-seconds <number>', 'Maximum wait for each notify workflow', '30')
  .parse().opts();

const maxSeconds = Number(options.maxSeconds);
if (!Number.isFinite(maxSeconds) || maxSeconds < 1 || maxSeconds > 60) throw new Error('max-seconds must be between 1 and 60');
const requested = String(options.providers).split(',');
if (requested.some(name => !['twilio', 'telnyx'].includes(name)) || new Set(requested).size !== requested.length) throw new Error('Invalid provider selection');
const source: Env = parseEnv(await readFile(options.envFile, 'utf8'));
const entries: ProviderConfig[] = [];
const report: Record<string, unknown>[] = [];
for (const type of requested) {
  if (type === 'twilio') {
    const useApiKey = !!source.TWILIO_API_KEY_SID && !!source.TWILIO_API_KEY_SECRET;
    if (!source.TWILIO_ACCOUNT_SID || (!useApiKey && !source.TWILIO_AUTH_TOKEN)) {
      report.push({ provider: type, status: 'not_tested', reason: 'Twilio credentials missing from the explicit environment file' });
      continue;
    }
    entries.push({ type, accountSid: source.TWILIO_ACCOUNT_SID,
      apiKeySidEnv: useApiKey ? 'TWILIO_API_KEY_SID' : 'TWILIO_ACCOUNT_SID',
      apiKeySecretEnv: useApiKey ? 'TWILIO_API_KEY_SECRET' : 'TWILIO_AUTH_TOKEN' });
  } else {
    if (!source.TELNYX_API_KEY) {
      report.push({ provider: type, status: 'not_tested', reason: 'TELNYX_API_KEY missing from the explicit environment file' });
      continue;
    }
    entries.push({ type: 'telnyx', apiKeyEnv: 'TELNYX_API_KEY' });
  }
}

const readRequests: { provider: string; status: number }[] = [];
const providerFetch: Fetch = async (input, init) => {
  const url = new URL(String(input));
  const origins = ['https://api.twilio.com', 'https://pricing.twilio.com', 'https://messaging.twilio.com', 'https://api.telnyx.com'];
  if ((init?.method ?? 'GET') !== 'GET' || !origins.includes(url.origin)) throw new Error('Live verification blocks provider mutations and unknown origins');
  const response = await fetch(input, init);
  readRequests.push({ provider: url.hostname.endsWith('twilio.com') ? 'twilio' : 'telnyx', status: response.status });
  return response;
};
const http = new Http(providerFetch);
for (const entry of entries) {
  const root = await mkdtemp(join(process.cwd(), '.test-state-live-'));
  try {
    const config = parseConfig({ version: 1, name: 'Read-only live verification', mode: 'notify',
      areaCodes: String(options.areaCodes).split(','), requiredCapabilities: ['voice', 'sms'], quantity: 1,
      durationHours: 1, providers: [entry], budget: { currency: 'USD', maxMonthlyPerNumber: '3.00' },
      notifications: { channels: [{ id: 'capture', type: 'webhook', webhookUrlEnv: 'CAPTURE_URL', webhookSecretEnv: 'CAPTURE_SECRET' }] } });
    const providers = createProviders(config, source, http);
    await providers[0].preflight(config);
    const round = await searchRound(config, providers);
    if (round.errors.length) throw new Error('Provider search or inventory reads failed');
    const requestStart = readRequests.length;
    const store = new Store(root);
    const job = await store.add(config);
    const captured: string[] = [];
    const captureSecret = 'local-verification-only';
    const notificationFetch: Fetch = async (input, init) => {
      if (String(input) !== 'https://capture.invalid/events') throw new Error('Unexpected notification destination');
      const headers = init?.headers as Record<string, string>;
      const body = String(init?.body);
      const signature = createHmac('sha256', captureSecret).update(`${headers['X-Number-Watcher-Timestamp']}.${body}`).digest('hex');
      if (signature !== headers['X-Number-Watcher-Signature']) throw new Error('Invalid webhook signature');
      const event = JSON.parse(body);
      if (event.jobId !== job.id) throw new Error('Unexpected notification job');
      captured.push(event.type);
      return new Response('ok');
    };
    const until = Date.now() + maxSeconds * 1000;
    const runner = new Runner(store, {
      providers: c => createProviders(c, source, http),
      notifications: c => new Notifications(c, { CAPTURE_URL: 'https://capture.invalid/events', CAPTURE_SECRET: captureSecret }, notificationFetch),
      stopped: () => Date.now() >= until
    });
    const result = await runner.run(job.id);
    const restored = await store.load(job.id);
    if (result.acquisitions.length !== 0 || restored.acquisitions.length !== 0) throw new Error('Notify verification unexpectedly created an acquisition');
    if (result.status !== 'succeeded' && round.candidates.length > 0) throw new Error('Notify workflow failed with matching inventory');
    if (result.status === 'succeeded') {
      const requestsAfterCompletion = readRequests.length;
      await runner.run(job.id);
      if (readRequests.length !== requestsAfterCompletion) throw new Error('Completed notify job made provider requests on resume');
    }
    report.push({ provider: entry.type, status: result.status === 'succeeded' ? 'passed' : 'no_match_within_test_window',
      authentication: 'passed', inventoryAndPriceReads: 'passed',
      matchesByAreaCode: config.areaCodes.map(code => ({ areaCode: code, count: round.candidates.filter(c => c.phoneNumber.slice(2, 5) === code).length })),
      sampleCapabilities: round.candidates[0]?.capabilities ?? [],
      quotedMonthly: round.candidates[0]?.price?.monthly ?? null,
      workflowProviderRequests: readRequests.length - requestStart, workflowStatus: result.status,
      capturedNotificationTypes: captured, webhookSignaturesVerified: captured.length > 0,
      persistedProgress: progress(restored), completedResumeMakesNoProviderCalls: result.status === 'succeeded',
      externalNotificationsSent: 0, providerMutations: 0 });
  } catch (error) {
    // Provider bodies, credential sources, URLs, and account identifiers stay private.
    report.push({ provider: entry.type, status: 'failed', reason: error instanceof Error && !/https?:|Bearer|Basic/i.test(error.message) ? error.message : 'Read-only verification failed' });
    process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ report, readRequests, externalNotificationsSent: 0, providerMutations: 0 }, null, 2));
if (!process.exitCode && report.some(item => item.status === 'not_tested')) process.exitCode = 2;
if (!process.exitCode && report.some(item => item.status === 'no_match_within_test_window')) process.exitCode = 3;

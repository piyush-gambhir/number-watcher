#!/usr/bin/env node
import { Command } from 'commander';
import { readConfig } from './config.js';
import { Runner, searchRound } from './engine.js';
import { Notifications } from './notifications/index.js';
import { createProviders } from './providers/index.js';
import { Store } from './store.js';
import { progress, systemClock, type Job } from './types.js';

const program = new Command().name('number-watcher').description('Watch and acquire phone numbers on Twilio and Telnyx')
  .option('--state-dir <path>', 'Persistent state directory', '.state')
  .option('--env-file <path>', 'Load environment variables from a local file');
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
program.hook('preAction', () => {
  const file = program.opts().envFile;
  if (file) process.loadEnvFile(file);
});
const print = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };
const store = () => new Store(program.opts().stateDir);
const runner = () => new Runner(store(), {
  providers: createProviders, notifications: config => new Notifications(config), stopped: () => stopped,
  log: message => process.stderr.write(JSON.stringify(message) + '\n')
});
function result(job: Job): void {
  print({ ...job, progress: progress(job) });
  process.exitCode = job.status === 'succeeded' ? 0 : job.status === 'expired' ? 3 : job.status === 'cancelled' ? 4 : 2;
}

program.command('check').requiredOption('--config <path>').option('--offline', 'Validate configuration without network calls or credentials')
  .action(async options => {
    const config = await readConfig(options.config);
    if (options.offline) { print({ valid: true, config }); return; }
    new Notifications(config);
    const providers = createProviders(config);
    for (const provider of providers) await provider.preflight(config);
    print(await searchRound(config, providers));
  });
program.command('add').requiredOption('--config <path>').description('Queue a validated request without provider calls or messages')
  .action(async options => {
    const job = await store().add(await readConfig(options.config));
    print({ id: job.id, status: job.status, mode: job.config.mode, quantity: job.config.quantity });
  });
program.command('start').requiredOption('--config <path>').description('Add and immediately run a request in its explicit configured mode')
  .action(async options => {
    const job = await store().add(await readConfig(options.config));
    process.stderr.write(`Job ${job.id}\n`);
    result(await runner().run(job.id));
  });
for (const command of ['run', 'resume']) program.command(command).requiredOption('--job <id>').action(async options => result(await runner().run(options.job)));
program.command('list').action(async () => print((await store().list()).map(job => ({
  id: job.id, name: job.config.name, mode: job.config.mode, status: job.status, phase: job.phase,
  createdAt: job.createdAt, deadline: job.deadline, progress: progress(job)
}))));
program.command('status').requiredOption('--job <id>').action(async options => {
  const job = await store().load(options.job);
  print({ ...job, cancellationRequested: await store().cancelled(job.id), progress: progress(job) });
});
program.command('cancel').requiredOption('--job <id>').action(async options => {
  await store().cancel(options.job);
  print({ id: options.job, cancellationRequested: true });
});
program.command('retry-notifications').requiredOption('--job <id>').action(async options => result(await runner().retryNotifications(options.job)));
program.command('worker').option('--once', 'Drain the current queue and exit instead of waiting for new requests')
  .description('Process queued requests one at a time; durations begin when execution starts')
  .action(async options => {
    while (!stopped) {
      const jobs = await store().list();
      const next = jobs.find(job => job.status === 'running') ?? jobs.find(job => job.status === 'queued');
      if (!next) {
        if (options.once) break;
        await systemClock.sleep(1000);
        continue;
      }
      const job = await runner().run(next.id);
      print({ id: job.id, status: job.status, progress: progress(job) });
      if (job.status === 'needs_attention' && job.acquisitions.some(a => !['configured', 'rejected'].includes(a.state))) {
        process.exitCode = 2;
        break;
      }
    }
  });

await program.parseAsync().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
});

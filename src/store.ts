import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { parseConfig, type Config } from './config.js';
import type { Job } from './types.js';

export const fingerprint = (config: Config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

export class Store {
  readonly root: string;
  constructor(root = '.state') { this.root = resolve(root); }
  path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job ID');
    return join(this.root, `${id}.json`);
  }
  async init(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async atomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async add(config: Config): Promise<Job> {
    await this.init();
    const job: Job = {
      version: 1, id: randomUUID(), config, fingerprint: fingerprint(config),
      createdAt: new Date().toISOString(), identities: {}, disabledProviders: [],
      status: 'queued', phase: 'queued', acquisitions: [], outbox: []
    };
    await this.save(job);
    return job;
  }
  async save(job: Job): Promise<void> { await this.atomic(this.path(job.id), job); }
  async load(id: string): Promise<Job> {
    const job: Job = JSON.parse(await readFile(this.path(id), 'utf8'));
    const config = parseConfig(job.config);
    if (job.id !== id || fingerprint(config) !== job.fingerprint) throw new Error('Saved job configuration changed; refusing to resume');
    job.config = config;
    return job;
  }
  async list(): Promise<Job[]> {
    await this.init();
    const ids = (await readdir(this.root)).filter(p => /^[a-f0-9-]{36}\.json$/.test(p));
    return (await Promise.all(ids.map(p => this.load(p.slice(0, -5))))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async cancel(id: string): Promise<void> { await this.load(id); await this.atomic(`${this.path(id)}.cancel`, { at: new Date().toISOString() }); }
  async cancelled(id: string): Promise<boolean> {
    try { await stat(`${this.path(id)}.cancel`); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async lock(): Promise<() => Promise<void>> {
    await this.init();
    return lockfile.lock(this.root, { realpath: true, stale: 30_000, update: 10_000, retries: 0 });
  }
}

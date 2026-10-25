import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../src/store.js';
import { fixtureStore } from './helpers.js';

function cli(root: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--state-dir', root, ...args], {
      cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
describe('request management CLI without credentials or provider calls', () => {
  let store: Store;
  let clean: () => Promise<void>;
  beforeEach(async () => { ({ store, clean } = await fixtureStore()); });
  afterEach(async () => { await clean(); });
  it('validates, queues, inspects, and cancels a request through actual commands', async () => {
    expect((await cli(store.root, 'check', '--config', 'examples/notify.json', '--offline')).code).toBe(0);
    const added = await cli(store.root, 'add', '--config', 'examples/purchase.json');
    expect(added.code).toBe(0);
    const { id } = JSON.parse(added.stdout);
    const list = await cli(store.root, 'list');
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ id, mode: 'purchase', status: 'queued' })]);
    expect((await cli(store.root, 'cancel', '--job', id)).code).toBe(0);
    const cancelled = await cli(store.root, 'run', '--job', id);
    expect(cancelled.code).toBe(4);
    expect(JSON.parse(cancelled.stdout).status).toBe('cancelled');
    const status = await cli(store.root, 'status', '--job', id);
    expect(JSON.parse(status.stdout)).toMatchObject({ cancellationRequested: true, status: 'cancelled' });
    expect((await cli(store.root, 'worker', '--once')).code).toBe(0);
  }, 15000);
  it('returns an actionable error when a request file is missing', async () => {
    const result = await cli(store.root, 'add', '--config', 'requests/does-not-exist.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ENOENT');
    expect(await store.list()).toEqual([]);
  });
});

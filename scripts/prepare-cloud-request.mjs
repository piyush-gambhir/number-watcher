import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw new Error('Usage: npm run cloud:request -- requests/job.json requests/submit.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
const requestId = randomUUID();
// Exclusive creation preserves the idempotency key of an existing request.
await writeFile(outputPath, JSON.stringify({ command: 'submit', requestId, config }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Request ${requestId} saved to ${outputPath}. Reuse this file when retrying the same submission.`);

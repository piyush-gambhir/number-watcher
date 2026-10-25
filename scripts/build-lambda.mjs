import { mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('build/lambda', { recursive: true, force: true });
await mkdir('build/lambda', { recursive: true });
await build({ entryPoints: ['src/cloud/handler.ts'], outfile: 'build/lambda/index.js',
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: false,
  sourcemap: false, logLevel: 'info' });

import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand,
  PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import { parseConfig, type Config } from '../config.js';
import { fingerprint } from '../store.js';
import type { Job } from '../types.js';

export interface JobSession {
  job: Job;
  save(): Promise<void>;
  cancelled(): Promise<boolean>;
}
export interface CloudStore {
  create(id: string, config: Config, now: number): Promise<Job>;
  load(id: string): Promise<Job>;
  cancel(id: string): Promise<void>;
  withLease<T>(id: string, work: (session: JobSession) => Promise<T>): Promise<T | undefined>;
}
export const validId = (id: string): string => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid job ID');
  return id;
};
export const newJob = (id: string, config: Config, now: number): Job => ({
  version: 1, id: validId(id), config, fingerprint: fingerprint(config),
  createdAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
  deadline: new Date(now + config.durationHours * 3600_000).toISOString(), nextPollAt: new Date(now).toISOString(),
  identities: {}, disabledProviders: [], status: 'queued', phase: 'queued', acquisitions: [], outbox: []
});
function encode(job: Job): Uint8Array {
  const bytes = gzipSync(JSON.stringify(job));
  if (bytes.length > 350_000) throw new Error('Job checkpoint exceeds its safe DynamoDB size limit');
  return bytes;
}

export class DynamoStore implements CloudStore {
  constructor(readonly table: string, readonly client = new DynamoDBClient({ maxAttempts: 1 }), readonly now = Date.now,
    readonly leaseSeconds = 180) {}
  key(id: string) { return { pk: { S: `JOB#${validId(id)}` } }; }
  async read(id: string): Promise<{ job: Job; revision: number }> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.table, Key: this.key(id), ConsistentRead: true }));
    if (!result.Item?.payload?.B) throw new Error('Job not found');
    const job: Job = JSON.parse(gunzipSync(result.Item.payload.B, { maxOutputLength: 16_000_000 }).toString());
    job.config = parseConfig(job.config);
    if (job.id !== id || fingerprint(job.config) !== job.fingerprint) throw new Error('Job configuration fingerprint mismatch');
    return { job, revision: Number(result.Item.revision.N) };
  }
  async load(id: string): Promise<Job> { return (await this.read(id)).job; }
  async create(id: string, config: Config, now: number): Promise<Job> {
    const job = newJob(id, config, now);
    try {
      await this.client.send(new PutItemCommand({ TableName: this.table,
        Item: { ...this.key(id), revision: { N: '0' }, payload: { B: encode(job) } },
        ConditionExpression: 'attribute_not_exists(pk)' }));
      return job;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const existing = await this.load(id);
      if (existing.fingerprint !== job.fingerprint) throw new Error('Request ID already belongs to a different configuration');
      return existing;
    }
  }
  async cancel(id: string): Promise<void> {
    await this.load(id);
    await this.client.send(new PutItemCommand({ TableName: this.table, Item: { pk: { S: `CANCEL#${validId(id)}` } } }));
  }
  async withLease<T>(id: string, work: (session: JobSession) => Promise<T>): Promise<T | undefined> {
    validId(id);
    const key = { pk: { S: `LEASE#${id}` } };
    const token = randomUUID();
    const expires = Math.floor(this.now() / 1000) + this.leaseSeconds;
    try {
      await this.client.send(new UpdateItemCommand({ TableName: this.table, Key: key,
        UpdateExpression: 'SET leaseToken = :token, expiresAt = :expires, ttl = :expires',
        ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now',
        ExpressionAttributeValues: { ':token': { S: token }, ':expires': { N: String(expires) }, ':now': { N: String(Math.floor(this.now() / 1000)) } } }));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return undefined;
      throw error;
    }
    try {
      const state = await this.read(id);
      return await work({ job: state.job,
        save: async () => {
          // The lease and revision fence every checkpoint, including the purchase intent.
          await this.client.send(new TransactWriteItemsCommand({ ClientRequestToken: randomUUID(), TransactItems: [
            { ConditionCheck: { TableName: this.table, Key: key, ConditionExpression: 'leaseToken = :token AND expiresAt > :now',
              ExpressionAttributeValues: { ':token': { S: token }, ':now': { N: String(Math.floor(this.now() / 1000)) } } } },
            { Put: { TableName: this.table, Item: { ...this.key(id), revision: { N: String(state.revision + 1) }, payload: { B: encode(state.job) } },
              ConditionExpression: 'revision = :revision', ExpressionAttributeValues: { ':revision': { N: String(state.revision) } } } }
          ] }));
          state.revision++;
        },
        cancelled: async () => !!(await this.client.send(new GetItemCommand({ TableName: this.table,
          Key: { pk: { S: `CANCEL#${id}` } }, ConsistentRead: true }))).Item
      });
    } finally {
      try {
        await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: key,
          ConditionExpression: 'leaseToken = :token', ExpressionAttributeValues: { ':token': { S: token } } }));
      } catch { /* A failed release expires after the Lambda timeout plus a safety margin. */ }
    }
  }
}

import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { randomUUID } from 'node:crypto';
import type { Job } from '../types.js';

export interface Schedules { ensure(job: Job): Promise<void>; remove(id: string): Promise<void> }
export class EventBridgeSchedules implements Schedules {
  constructor(readonly group: string, readonly functionArn: string, readonly roleArn: string, readonly dlqArn: string,
    readonly client = new SchedulerClient({ maxAttempts: 3 }), readonly now = Date.now) {}
  name(id: string): string { return `job-${id}`; }
  async ensure(job: Job): Promise<void> {
    const seconds = job.config.pollIntervalSeconds;
    if (seconds % 60) throw new Error('AWS scheduling requires pollIntervalSeconds to be a whole number of minutes');
    const minutes = seconds / 60;
    const recoveryMs = Math.max(1800_000, seconds * 6000 + 600_000);
    try {
      await this.client.send(new CreateScheduleCommand({ Name: this.name(job.id), GroupName: this.group,
        ClientToken: randomUUID(), ScheduleExpression: `rate(${minutes} minutes)`, FlexibleTimeWindow: { Mode: 'OFF' },
        StartDate: new Date(this.now() + seconds * 1000),
        EndDate: new Date(Math.max(Date.parse(job.deadline!), this.now()) + recoveryMs), ActionAfterCompletion: 'DELETE',
        Target: { Arn: this.functionArn, RoleArn: this.roleArn, Input: JSON.stringify({ command: 'poll', jobId: job.id }),
          RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 2 }, DeadLetterConfig: { Arn: this.dlqArn } } }));
    } catch (error) { if (!(error instanceof Error) || error.name !== 'ConflictException') throw error; }
  }
  async remove(id: string): Promise<void> {
    try { await this.client.send(new DeleteScheduleCommand({ Name: this.name(id), GroupName: this.group })); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error; }
  }
}

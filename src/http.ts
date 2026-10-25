import type { Clock } from './types.js';
import { systemClock } from './types.js';

// Provider JSON is validated and normalized at each adapter boundary.
export type Json = Record<string, any>;
export type Fetch = typeof globalThis.fetch;
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly method: string) {
    super(`Provider ${method} failed (HTTP ${status}, code ${code})`);
  }
}
export class Http {
  constructor(readonly fetch: Fetch = globalThis.fetch, readonly clock: Clock = systemClock) {}
  async request(url: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<Json> {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.fetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000), redirect: 'error' });
        let data: Json;
        try { data = await response.json() as Json; }
        catch { throw new ApiError(response.status, 'invalid_json', method); }
        if (!response.ok) {
          const raw = String(data.code ?? data.errors?.[0]?.code ?? 'unknown');
          throw new ApiError(response.status, /^[a-zA-Z0-9_-]{1,80}$/.test(raw) ? raw : 'unknown', method);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response');
        return data;
      } catch (error) {
        const retry = method === 'GET' && (!(error instanceof ApiError) || error.status === 429 || error.status >= 500);
        if (!retry || attempt === attempts - 1) throw error instanceof ApiError ? error : new Error('Provider transport or response failure');
        await this.clock.sleep((attempt + 1) * 1000 + Math.floor(Math.random() * 250));
      }
    }
    throw new Error('Unreachable request state');
  }
}

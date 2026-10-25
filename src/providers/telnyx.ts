import { createHash } from 'node:crypto';
import { secret, type Config, type Env, type ProviderConfig } from '../config.js';
import { ApiError, Http, type Json } from '../http.js';
import type { Acquisition, Candidate, Capability, Price, Provider } from '../types.js';

export class Telnyx implements Provider {
  readonly type = 'telnyx' as const;
  readonly headers: Record<string, string>;
  readonly credentialIdentity: string;
  readonly base = 'https://api.telnyx.com/v2';
  constructor(readonly config: Extract<ProviderConfig, { type: 'telnyx' }>, env: Env, readonly http = new Http()) {
    const key = secret(env, config.apiKeyEnv);
    this.headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    // Pin the key across restarts without persisting the credential itself.
    this.credentialIdentity = `key-sha256:${createHash('sha256').update(key).digest('hex')}`;
  }
  get(path: string): Promise<Json> { return this.http.request(`${this.base}${path}`, this.headers); }
  async pages(path: string, query: Record<string, string> = {}): Promise<Json[]> {
    const result: Json[] = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.get(`${path}?${new URLSearchParams({ ...query, 'page[size]': '250', 'page[number]': String(page) })}`);
      if (!Array.isArray(data.data)) throw new Error('Invalid Telnyx list response');
      result.push(...data.data);
      if (data.meta?.total_pages !== undefined ? page >= data.meta.total_pages : data.data.length < 250) return result;
    }
    throw new Error('Telnyx pagination limit exceeded');
  }
  async routes(config: Config): Promise<void> {
    const purchase = this.config.purchase!;
    if (config.requiredCapabilities.includes('voice')) {
      const { data } = await this.get(`/call_control_applications/${purchase.connectionId}`);
      if (data?.id !== purchase.connectionId || data.active !== true || data.webhook_event_url !== purchase.expectedVoiceWebhookUrl) throw new Error('Telnyx Call Control application is inactive or its webhook does not match');
    }
    if (config.requiredCapabilities.includes('sms')) {
      const { data } = await this.get(`/messaging_profiles/${purchase.messagingProfileId}`);
      if (data?.id !== purchase.messagingProfileId || data.enabled !== true || data.webhook_url !== purchase.expectedSmsWebhookUrl) throw new Error('Telnyx Messaging Profile is disabled or its webhook does not match');
    }
  }
  async preflight(config: Config): Promise<string> {
    const { data } = await this.get('/balance');
    if (!data || typeof data.balance !== 'string') throw new Error('Invalid Telnyx balance response');
    if (config.mode === 'purchase') await this.routes(config);
    return this.credentialIdentity;
  }
  async ownedNumbers(): Promise<string[]> { return (await this.pages('/phone_numbers')).map(n => n.phone_number); }
  price(number: Json): Price {
    return { currency: String(number.cost_information?.currency ?? ''),
      monthly: number.cost_information?.monthly_cost == null ? null : String(number.cost_information.monthly_cost),
      oneTime: number.cost_information?.upfront_cost == null ? null : String(number.cost_information.upfront_cost),
      observedAt: new Date(this.http.clock.now()).toISOString(), source: 'Telnyx exact-number search' };
  }
  async inventory(query: URLSearchParams): Promise<Candidate[]> {
    const result = await this.get(`/available_phone_numbers?${query}`);
    if (!Array.isArray(result.data)) throw new Error('Invalid Telnyx inventory response');
    return result.data.map((n: Json) => ({
      provider: this.type, phoneNumber: n.phone_number,
      country: n.region_information?.find((r: Json) => r.region_type === 'country_code')?.region_name ?? '',
      numberType: n.phone_number_type ?? 'local', bestEffort: n.best_effort === true,
      capabilities: (n.features ?? []).map((f: Json) => f.name).filter((f: string) => ['voice', 'sms', 'mms'].includes(f)) as Capability[],
      price: this.price(n)
    }));
  }
  async search(config: Config, areaCode: string, limit: number): Promise<Candidate[]> {
    const query = new URLSearchParams({ 'filter[country_code]': 'US', 'filter[phone_number_type]': 'local',
      'filter[national_destination_code]': areaCode, 'filter[best_effort]': 'false', 'filter[limit]': String(limit) });
    for (const c of config.requiredCapabilities) query.append('filter[features][]', c);
    return this.inventory(query);
  }
  async quote(candidate: Candidate): Promise<Price> {
    const query = new URLSearchParams({ 'filter[country_code]': 'US', 'filter[phone_number_type]': 'local',
      'filter[phone_number][starts_with]': candidate.phoneNumber, 'filter[best_effort]': 'false', 'filter[limit]': '1' });
    const match = (await this.inventory(query)).find(n => n.phoneNumber === candidate.phoneNumber);
    if (!match?.price || match.bestEffort || !candidate.capabilities.every(c => match.capabilities.includes(c))) throw new Error('Telnyx candidate is no longer available with the required capabilities');
    return match.price;
  }
  async acquire(config: Config, acquisition: Acquisition): Promise<Acquisition> {
    const purchase = this.config.purchase!;
    try {
      const { data } = await this.http.request(`${this.base}/number_orders`, this.headers, 'POST', JSON.stringify({
        phone_numbers: [{ phone_number: acquisition.candidate.phoneNumber }],
        customer_reference: acquisition.reference,
        ...(config.requiredCapabilities.includes('voice') ? { connection_id: purchase.connectionId } : {}),
        ...(config.requiredCapabilities.includes('sms') ? { messaging_profile_id: purchase.messagingProfileId } : {})
      }));
      if (!data?.id) return { ...acquisition, state: 'unknown', error: 'Telnyx order ID missing' };
      return { ...acquisition, state: 'pending', orderId: data.id };
    } catch (error) {
      if (error instanceof ApiError && error.code === '85001') return { ...acquisition, state: 'rejected', error: error.message };
      return { ...acquisition, state: 'unknown', error: error instanceof ApiError ? error.message : 'Telnyx order outcome uncertain' };
    }
  }
  async reconcile(_config: Config, acquisition: Acquisition): Promise<Acquisition> {
    let order: Json | undefined;
    if (acquisition.orderId) order = (await this.get(`/number_orders/${acquisition.orderId}`)).data;
    else {
      const orders = await this.pages('/number_orders', { 'filter[customer_reference]': acquisition.reference });
      const matches = orders.filter(o => o.customer_reference === acquisition.reference && o.phone_numbers?.some((n: Json) => n.phone_number === acquisition.candidate.phoneNumber));
      if (matches.length === 1) order = (await this.get(`/number_orders/${matches[0].id}`)).data;
    }
    if (!order || order.customer_reference !== acquisition.reference || !order.phone_numbers?.some((n: Json) => n.phone_number === acquisition.candidate.phoneNumber)) {
      return { ...acquisition, state: 'unknown', error: 'Telnyx order could not be attributed to this job' };
    }
    const owned = (await this.pages('/phone_numbers', { 'filter[phone_number]': acquisition.candidate.phoneNumber.slice(1) })).find(n => n.phone_number === acquisition.candidate.phoneNumber);
    if (owned && order.status === 'success' && owned.status === 'active') return { ...acquisition, orderId: order.id, resourceId: owned.id, state: 'owned', error: undefined };
    if (['failure', 'cancelled'].includes(order.status) && !owned) return { ...acquisition, orderId: order.id, state: 'rejected', error: `Telnyx order ${order.status}` };
    return { ...acquisition, orderId: order.id, state: 'pending', error: `Telnyx order status: ${String(order.status)}; requirements: ${String(order.requirements_met)}` };
  }
  async configure(config: Config, acquisition: Acquisition): Promise<void> {
    if (!acquisition.resourceId) throw new Error('Telnyx phone number ID missing');
    const { data } = await this.get(`/phone_numbers/${acquisition.resourceId}`);
    if (data?.phone_number !== acquisition.candidate.phoneNumber || data.status !== 'active') throw new Error('Telnyx number is not active or does not match');
    const purchase = this.config.purchase!;
    if (config.requiredCapabilities.includes('voice') && data.connection_id !== purchase.connectionId) throw new Error('Telnyx voice connection assignment mismatch');
    if (config.requiredCapabilities.includes('sms')) {
      const messaging = (await this.get(`/phone_numbers/${acquisition.resourceId}/messaging`)).data;
      if (messaging?.messaging_profile_id !== purchase.messagingProfileId) throw new Error('Telnyx Messaging Profile assignment mismatch');
    }
    await this.routes(config);
  }
}

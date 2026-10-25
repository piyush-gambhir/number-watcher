import { secret, type Config, type Env, type ProviderConfig } from '../config.js';
import { ApiError, Http, type Json } from '../http.js';
import type { Acquisition, Candidate, Capability, Price, Provider } from '../types.js';

export class Twilio implements Provider {
  readonly type = 'twilio' as const;
  readonly headers: Record<string, string>;
  readonly base: string;
  constructor(readonly config: Extract<ProviderConfig, { type: 'twilio' }>, env: Env, readonly http = new Http()) {
    this.headers = { Authorization: `Basic ${Buffer.from(`${secret(env, config.apiKeySidEnv)}:${secret(env, config.apiKeySecretEnv)}`).toString('base64')}` };
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
  }
  get(url: string): Promise<Json> { return this.http.request(url, this.headers); }
  post(url: string, fields: Record<string, string>): Promise<Json> {
    return this.http.request(url, { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', new URLSearchParams(fields).toString());
  }
  async pages(url: string, key: string): Promise<Json[]> {
    const result: Json[] = [];
    for (let page = 0; page < 100; page++) {
      const parsed = new URL(url);
      if (!['https://api.twilio.com', 'https://messaging.twilio.com'].includes(parsed.origin)) throw new Error('Invalid Twilio pagination origin');
      const data = await this.get(url);
      if (!Array.isArray(data[key])) throw new Error('Invalid Twilio list response');
      result.push(...data[key]);
      const next = data.next_page_uri ?? data.meta?.next_page_url;
      if (!next) return result;
      url = new URL(next, url).toString();
    }
    throw new Error('Twilio pagination limit exceeded');
  }
  async service(config: Config): Promise<void> {
    if (!config.requiredCapabilities.includes('sms')) return;
    const purchase = this.config.purchase!;
    const base = `https://messaging.twilio.com/v1/Services/${purchase.messagingServiceSid}`;
    const service = await this.get(base);
    if (service.account_sid !== this.config.accountSid) throw new Error('Twilio Messaging Service account mismatch');
    if (service.use_inbound_webhook_on_number !== true &&
      (service.inbound_request_url !== purchase.smsUrl || service.inbound_method !== 'POST')) {
      throw new Error('Twilio Messaging Service overrides the requested SMS webhook');
    }
  }
  async preflight(config: Config): Promise<string> {
    const account = await this.get(`${this.base}.json`);
    if (account.sid !== this.config.accountSid || account.status !== 'active') throw new Error('Twilio target account is not active or does not match');
    if (config.mode === 'purchase') {
      await this.service(config);
      if (config.requiredCapabilities.includes('sms')) {
        const numbers = await this.pages(`https://messaging.twilio.com/v1/Services/${this.config.purchase!.messagingServiceSid}/PhoneNumbers?PageSize=400`, 'phone_numbers');
        if (numbers.length + config.quantity > 400) throw new Error('Twilio service would exceed its default 400-number capacity');
      }
    }
    return account.sid;
  }
  async ownedNumbers(): Promise<string[]> {
    return (await this.pages(`${this.base}/IncomingPhoneNumbers.json?PageSize=1000`, 'incoming_phone_numbers')).map(n => n.phone_number);
  }
  async search(config: Config, areaCode: string, limit: number): Promise<Candidate[]> {
    const query = new URLSearchParams({ AreaCode: areaCode, PageSize: String(limit) });
    for (const capability of config.requiredCapabilities) query.set(`${capability[0].toUpperCase()}${capability.slice(1)}Enabled`, 'true');
    const result = await this.get(`${this.base}/AvailablePhoneNumbers/US/Local.json?${query}`);
    if (!Array.isArray(result.available_phone_numbers)) throw new Error('Invalid Twilio inventory response');
    return result.available_phone_numbers.map((n: Json) => ({
      provider: this.type, phoneNumber: n.phone_number, country: n.iso_country, numberType: 'local',
      capabilities: (['voice', 'sms', 'mms'] as Capability[]).filter(c => n.capabilities?.[c] === true)
    }));
  }
  async quote(_candidate: Candidate): Promise<Price> {
    const data = await this.get('https://pricing.twilio.com/v1/PhoneNumbers/Countries/US');
    const local = data.phone_number_prices?.find((p: Json) => p.number_type === 'local');
    return { currency: String(data.price_unit ?? ''), monthly: local?.current_price == null ? null : String(local.current_price),
      oneTime: null, observedAt: new Date(this.http.clock.now()).toISOString(), source: 'Twilio US local account pricing' };
  }
  async acquire(config: Config, acquisition: Acquisition): Promise<Acquisition> {
    const fields: Record<string, string> = { PhoneNumber: acquisition.candidate.phoneNumber, FriendlyName: acquisition.reference };
    const purchase = this.config.purchase!;
    if (config.requiredCapabilities.includes('voice')) Object.assign(fields, { VoiceUrl: purchase.voiceUrl, VoiceMethod: 'POST' });
    if (config.requiredCapabilities.includes('sms')) Object.assign(fields, { SmsUrl: purchase.smsUrl, SmsMethod: 'POST' });
    try {
      const number = await this.post(`${this.base}/IncomingPhoneNumbers.json`, fields);
      if (!number.sid || number.phone_number !== acquisition.candidate.phoneNumber) return { ...acquisition, state: 'unknown', error: 'Unexpected Twilio purchase response' };
      return { ...acquisition, state: 'owned', resourceId: number.sid };
    } catch (error) {
      if (error instanceof ApiError && (error.code === '21422' || error.status === 429)) return { ...acquisition, state: 'rejected', error: error.message };
      return { ...acquisition, state: 'unknown', error: error instanceof ApiError ? error.message : 'Twilio purchase outcome uncertain' };
    }
  }
  async reconcile(_config: Config, acquisition: Acquisition): Promise<Acquisition> {
    const numbers = await this.get(`${this.base}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: acquisition.candidate.phoneNumber })}`);
    const number = numbers.incoming_phone_numbers?.find((n: Json) => n.phone_number === acquisition.candidate.phoneNumber && n.friendly_name === acquisition.reference && n.account_sid === this.config.accountSid);
    return number ? { ...acquisition, state: 'owned', resourceId: number.sid, error: undefined } : { ...acquisition, state: 'unknown', error: 'Twilio purchase could not be attributed to this job' };
  }
  async configure(config: Config, acquisition: Acquisition): Promise<void> {
    if (!acquisition.resourceId) throw new Error('Twilio number SID missing');
    const url = `${this.base}/IncomingPhoneNumbers/${acquisition.resourceId}.json`;
    const number = await this.get(url);
    if (number.phone_number !== acquisition.candidate.phoneNumber || number.friendly_name !== acquisition.reference) throw new Error('Twilio ownership marker mismatch');
    const purchase = this.config.purchase!;
    const updates: Record<string, string> = {};
    const voice = config.requiredCapabilities.includes('voice');
    const sms = config.requiredCapabilities.includes('sms');
    if (voice && (number.voice_application_sid || number.trunk_sid)) throw new Error('Twilio number has a conflicting voice application or trunk');
    if (sms && number.sms_application_sid) throw new Error('Twilio number has a conflicting SMS application');
    if (voice && (number.voice_url !== purchase.voiceUrl || number.voice_method !== 'POST')) Object.assign(updates, { VoiceUrl: purchase.voiceUrl, VoiceMethod: 'POST' });
    if (sms && (number.sms_url !== purchase.smsUrl || number.sms_method !== 'POST')) Object.assign(updates, { SmsUrl: purchase.smsUrl, SmsMethod: 'POST' });
    if (Object.keys(updates).length) await this.post(url, updates);
    if (sms) {
      await this.service(config);
      const base = `https://messaging.twilio.com/v1/Services/${purchase.messagingServiceSid}/PhoneNumbers`;
      try { await this.get(`${base}/${acquisition.resourceId}`); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        await this.post(base, { PhoneNumberSid: acquisition.resourceId });
      }
      const membership = await this.get(`${base}/${acquisition.resourceId}`);
      if (membership.sid !== acquisition.resourceId || membership.service_sid !== purchase.messagingServiceSid) throw new Error('Twilio service membership mismatch');
      await this.service(config);
    }
    const verified = await this.get(url);
    if (voice && (verified.voice_url !== purchase.voiceUrl || verified.voice_method !== 'POST' || verified.voice_application_sid || verified.trunk_sid)) throw new Error('Twilio voice route verification failed');
    if (sms && (verified.sms_url !== purchase.smsUrl || verified.sms_method !== 'POST' || verified.sms_application_sid)) throw new Error('Twilio SMS route verification failed');
  }
}

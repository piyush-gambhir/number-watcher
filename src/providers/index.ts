import type { Config, Env } from '../config.js';
import { Http } from '../http.js';
import type { Provider } from '../types.js';
import { Twilio } from './twilio.js';
import { Telnyx } from './telnyx.js';

export function createProviders(config: Config, env: Env = process.env, http = new Http()): Provider[] {
  return config.providers.map(provider => provider.type === 'twilio' ? new Twilio(provider, env, http) : new Telnyx(provider, env, http));
}

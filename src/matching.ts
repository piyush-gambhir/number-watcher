import type { Config } from './config.js';
import type { Candidate, Price } from './types.js';

export function decimal(value: string): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(value)) throw new Error('Unsupported price precision or format');
  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fractional.padEnd(4, '0'));
}
export function withinBudget(config: Config, price?: Price): boolean {
  if (!config.budget) return true;
  if (!price || price.currency.toUpperCase() !== 'USD' || price.monthly === null) return false;
  try {
    if (decimal(price.monthly) > decimal(config.budget.maxMonthlyPerNumber)) return false;
    const maximum = config.budget.maxOneTimeFeePerNumber;
    return maximum === undefined || (price.oneTime !== null && decimal(price.oneTime) <= decimal(maximum));
  } catch { return false; }
}
export function matches(config: Config, candidate: Candidate): boolean {
  return /^\+1[2-9]\d{9}$/.test(candidate.phoneNumber)
    && config.areaCodes.includes(candidate.phoneNumber.slice(2, 5))
    && candidate.country === 'US' && candidate.numberType === 'local' && candidate.bestEffort !== true
    && config.requiredCapabilities.every(c => candidate.capabilities.includes(c));
}
export function selectCandidates(config: Config, candidates: Candidate[], excluded: Set<string> = new Set()): Candidate[] {
  const sorted = candidates.filter(c => matches(config, c) && withinBudget(config, c.price) && !excluded.has(c.phoneNumber)).sort((a, b) =>
    config.areaCodes.indexOf(a.phoneNumber.slice(2, 5)) - config.areaCodes.indexOf(b.phoneNumber.slice(2, 5))
    || config.providers.findIndex(p => p.type === a.provider) - config.providers.findIndex(p => p.type === b.provider)
    || a.phoneNumber.localeCompare(b.phoneNumber)
  );
  const seen = new Set<string>();
  return sorted.filter(c => { if (seen.has(c.phoneNumber)) return false; seen.add(c.phoneNumber); return true; });
}

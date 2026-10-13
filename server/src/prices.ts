/**
 * Price table: US dollars per million tokens, Anthropic first-party API rates (cached 2026-10-06).
 * Edit this file when prices change. A model id matches the longest prefix, so dated ids also match.
 * Cache writes: 1.25x input (5-minute TTL), 2x input (1-hour TTL). Cache reads: 0.1x input, unless `cacheRead` is set.
 */

export interface Price {
  input: number;
  output: number;
  /** Cache read price, when it is not 0.1x input. */
  cacheRead?: number;
  /** Higher prices when the prompt is longer than `tokens` (Claude Haiku 5.5). */
  long?: { tokens: number; input: number; output: number };
}

export const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { tokens: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Fast mode (usage.speed "fast") costs this many times the standard price. */
const FAST_MULTIPLIER = 2;

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

export function priceOf(model: string): Price | null {
  const key = KEYS.find((k) => model === k || model.startsWith(`${k}-`) || model.startsWith(`${k}@`) || model.startsWith(`${k}[`));
  return key ? PRICES[key] : null;
}

/** The usage block of an assistant message, as Claude Code writes it in the JSONL file. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  speed?: string | null;
}

/** Cost in US dollars, or null for an unknown model. */
export function costOf(model: string, usage: Usage): number | null {
  const price = priceOf(model);
  if (!price) return null;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : write;

  const long = price.long && input + read + write > price.long.tokens;
  const inPrice = long ? price.long!.input : price.input;
  const outPrice = long ? price.long!.output : price.output;
  const readPrice = !long && price.cacheRead !== undefined ? price.cacheRead : inPrice * 0.1;

  const dollars = (input * inPrice + output * outPrice + write5m * inPrice * 1.25 + write1h * inPrice * 2 + read * readPrice) / 1_000_000;
  return usage.speed === 'fast' ? dollars * FAST_MULTIPLIER : dollars;
}

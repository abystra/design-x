const tokenFields = {
  input_tokens: 'inputTokens',
  output_tokens: 'outputTokens',
  cached_input_tokens: 'cachedInputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens',
  reasoning_output_tokens: 'reasoningOutputTokens',
  total_tokens: 'totalTokens',
} as const;
type TokenField = keyof typeof tokenFields;
export type TokenCounters = Partial<Record<TokenField, number>>;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Accept only actual, nonnegative integer counters; absent values stay absent. */
export function safeTokenUsage(value: unknown): TokenCounters {
  const source = record(value), result: TokenCounters = {};
  if (!source) return result;
  for (const [canonical, native] of Object.entries(tokenFields)) {
    const counter = source[canonical] ?? source[native];
    if (typeof counter === 'number' && Number.isSafeInteger(counter) && counter >= 0)
      result[canonical as TokenField] = counter;
  }
  return result;
}

/** Codex total is cumulative for the native thread; last is one model request. */
export function nativeUsageTotal(value: unknown): TokenCounters | null {
  const total = record(record(value)?.total);
  if (!total) return null;
  const counters = safeTokenUsage(total);
  return Object.keys(counters).length ? counters : null;
}

export type NativeAttemptUsage = TokenCounters & {
  native: {
    version: 1;
    threadId: string;
    resumed: boolean;
    baseline: TokenCounters | null;
    total: TokenCounters | null;
    sequence: number;
    status: 'pending' | 'known' | 'partial' | 'unknown';
  };
};

/** Persist this once at session.ready, so observer reconnects cannot reset it. */
export function beginNativeUsage(threadId: string, resumed: boolean, priorTotal: TokenCounters | null): NativeAttemptUsage {
  const baseline = resumed ? priorTotal : Object.fromEntries(Object.keys(tokenFields).map(key => [key, 0]));
  return {native: {version: 1, threadId, resumed, baseline, total: null, sequence: 0, status: baseline ? 'pending' : 'unknown'}};
}

/** Replace a cumulative snapshot with its attempt delta; never sum snapshots. */
export function updateNativeUsage(previous: NativeAttemptUsage, value: unknown, sequence: number): NativeAttemptUsage {
  if (sequence <= previous.native.sequence) return previous;
  const total = nativeUsageTotal(value), baseline = previous.native.baseline;
  const counters: TokenCounters = {};
  if (total && baseline) {
    for (const key of Object.keys(tokenFields) as TokenField[]) {
      if (total[key] !== undefined && baseline[key] !== undefined && total[key]! >= baseline[key]!)
        counters[key] = total[key]! - baseline[key]!;
    }
  }
  const status = counters.input_tokens !== undefined && counters.output_tokens !== undefined ? 'known'
    : Object.keys(counters).length ? 'partial' : 'unknown';
  return {...counters, native: {...previous.native, total, sequence, status}};
}

import { isFetchForgeError } from './errors.ts';
import type { CircuitState, Plugin } from './types.ts';

export type MonitorEvent =
  | {
      type: 'request';
      group: string;
      method: string;
      url: string;
      ok: boolean;
      status?: number;
      code?: string;
      attempts: number;
      durationMs: number;
    }
  | { type: 'retry'; group: string; attempt: number; delay: number; code?: string }
  | { type: 'circuit'; key: string; from: CircuitState; to: CircuitState };

export interface MonitorOptions {
  /**
   * How requests are grouped in the statistics. `'origin'` (default) uses scheme + host,
   * `'route'` adds the path with ids replaced by `:id`, or pass your own function.
   */
  groupBy?: 'origin' | 'route' | ((request: { url: string; method: string }) => string);
  /** Latency histogram bucket upper bounds in ms, ascending. */
  buckets?: number[];
  /** Cap on distinct groups; further groups are merged into `__other__`. Default 500. */
  maxGroups?: number;
  /** Called for every request, retry and circuit change, e.g. to forward to OpenTelemetry or StatsD. */
  onEvent?: (event: MonitorEvent) => void;
}

export interface GroupStats {
  requests: number;
  succeeded: number;
  failed: number;
  attempts: number;
  retries: number;
  /** Failures by error code, e.g. `{ ERR_HTTP: 2, ERR_TIMEOUT: 1 }`. */
  errors: Record<string, number>;
  /** Responses by HTTP status. */
  statusCodes: Record<string, number>;
  latency: {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  };
}

export interface MonitorSnapshot {
  groups: Record<string, GroupStats>;
  circuits: Record<string, { state: CircuitState; opened: number }>;
}

export interface MonitorPlugin extends Plugin {
  /** A copy of the collected statistics. */
  snapshot: () => MonitorSnapshot;
  /** Statistics in the Prometheus text exposition format. */
  toPrometheus: (prefix?: string) => string;
  /** Clears all collected statistics. */
  reset: () => void;
}

interface Group {
  requests: number;
  succeeded: number;
  failed: number;
  attempts: number;
  retries: number;
  errors: Map<string, number>;
  statusCodes: Map<string, number>;
  counts: number[];
  sum: number;
  min: number;
  max: number;
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const OTHER = '__other__';
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

function groupOf(mode: MonitorOptions['groupBy'], request: { url: string; method: string }): string {
  if (typeof mode === 'function') return String(mode(request));
  try {
    const url = new URL(request.url);
    if (mode === 'route') {
      const path = url.pathname
        .split('/')
        .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
        .join('/');
      return `${url.origin}${path}`;
    }
    return url.origin;
  } catch {
    return request.url;
  }
}

function percentile(group: Group, buckets: number[], p: number): number {
  const total = group.counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const rank = Math.ceil(total * p);
  let seen = 0;
  for (let i = 0; i < group.counts.length; i++) {
    seen += group.counts[i] as number;
    if (seen >= rank) return i < buckets.length ? Math.min(buckets[i] as number, group.max) : group.max;
  }
  return group.max;
}

const escapeLabel = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Collects request statistics (counts, error codes, status codes, latency percentiles) per group,
 * and can export them as a snapshot, as Prometheus text, or as a stream of events. Memory is bounded:
 * latency is kept in fixed histogram buckets and the number of groups is capped.
 * With `dedupe`, calls that joined an in-flight request are not counted separately.
 */
export function monitor(options: MonitorOptions = {}): MonitorPlugin {
  const { groupBy = 'origin', maxGroups = 500, onEvent } = options;
  const buckets = [...(options.buckets ?? DEFAULT_BUCKETS)];
  if (
    buckets.length === 0 ||
    buckets.some((b, i) => !(b > 0) || (i > 0 && b <= (buckets[i - 1] as number)))
  ) {
    throw new RangeError('buckets must be a non-empty, strictly ascending list of positive numbers');
  }
  if (!Number.isInteger(maxGroups) || maxGroups < 1)
    throw new RangeError('maxGroups must be a positive integer');

  const groups = new Map<string, Group>();
  const circuits = new Map<string, { state: CircuitState; opened: number }>();

  const blank = (): Group => ({
    requests: 0,
    succeeded: 0,
    failed: 0,
    attempts: 0,
    retries: 0,
    errors: new Map(),
    statusCodes: new Map(),
    counts: new Array(buckets.length + 1).fill(0),
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
  });

  const groupFor = (name: string): Group => {
    let key = name;
    if (!groups.has(key) && groups.size >= maxGroups) key = OTHER;
    let group = groups.get(key);
    if (!group) {
      group = blank();
      groups.set(key, group);
    }
    return group;
  };

  const emit = (event: MonitorEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // Observers must not break requests.
    }
  };

  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  const stats = (group: Group): GroupStats => ({
    requests: group.requests,
    succeeded: group.succeeded,
    failed: group.failed,
    attempts: group.attempts,
    retries: group.retries,
    errors: Object.fromEntries(group.errors),
    statusCodes: Object.fromEntries(group.statusCodes),
    latency: {
      count: group.requests,
      sum: group.sum,
      min: group.requests === 0 ? 0 : group.min,
      max: group.max,
      avg: group.requests === 0 ? 0 : Math.round((group.sum / group.requests) * 100) / 100,
      p50: percentile(group, buckets, 0.5),
      p95: percentile(group, buckets, 0.95),
      p99: percentile(group, buckets, 0.99),
    },
  });

  return {
    name: 'monitor',
    snapshot: () => ({
      groups: Object.fromEntries([...groups].map(([name, group]) => [name, stats(group)])),
      circuits: Object.fromEntries([...circuits].map(([key, value]) => [key, { ...value }])),
    }),
    reset: () => {
      groups.clear();
      circuits.clear();
    },
    toPrometheus: (prefix = 'fetchforge') => {
      const name = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
      const lines: string[] = [];
      const header = (metric: string, type: string, help: string) => {
        lines.push(`# HELP ${name}_${metric} ${help}`, `# TYPE ${name}_${metric} ${type}`);
      };
      const label = (group: string, extra = '') => `{group="${escapeLabel(group)}"${extra}}`;

      header('requests_total', 'counter', 'Completed requests by outcome.');
      for (const [g, s] of groups) {
        lines.push(`${name}_requests_total${label(g, ',outcome="success"')} ${s.succeeded}`);
        lines.push(`${name}_requests_total${label(g, ',outcome="failure"')} ${s.failed}`);
      }
      header('errors_total', 'counter', 'Failed requests by error code.');
      for (const [g, s] of groups) {
        for (const [code, n] of s.errors)
          lines.push(`${name}_errors_total${label(g, `,code="${escapeLabel(code)}"`)} ${n}`);
      }
      header('retries_total', 'counter', 'Retries performed.');
      for (const [g, s] of groups) lines.push(`${name}_retries_total${label(g)} ${s.retries}`);
      header('request_duration_ms', 'histogram', 'Request duration in milliseconds, including retries.');
      for (const [g, s] of groups) {
        let cumulative = 0;
        buckets.forEach((bound, i) => {
          cumulative += s.counts[i] as number;
          lines.push(`${name}_request_duration_ms_bucket${label(g, `,le="${bound}"`)} ${cumulative}`);
        });
        lines.push(`${name}_request_duration_ms_bucket${label(g, ',le="+Inf"')} ${s.requests}`);
        lines.push(`${name}_request_duration_ms_sum${label(g)} ${s.sum}`);
        lines.push(`${name}_request_duration_ms_count${label(g)} ${s.requests}`);
      }
      header('circuit_open_total', 'counter', 'Times a circuit opened.');
      for (const [key, c] of circuits)
        lines.push(`${name}_circuit_open_total{key="${escapeLabel(key)}"} ${c.opened}`);
      return `${lines.join('\n')}\n`;
    },
    hooks: {
      beforeRetry: ({ request, attempt, delay, error }) => {
        const group = groupOf(groupBy, request);
        groupFor(group).retries++;
        emit({
          type: 'retry',
          group,
          attempt,
          delay,
          code: isFetchForgeError(error) ? error.code : undefined,
        });
      },
      onComplete: ({ request, result, error, attempts, durationMs }) => {
        const groupName = groupOf(groupBy, request);
        const group = groupFor(groupName);
        const failure = error ?? result?.error ?? undefined;
        const code = failure ? (isFetchForgeError(failure) ? failure.code : 'ERR_UNKNOWN') : undefined;
        const status = result?.status ?? (error as { status?: number } | undefined)?.status;

        group.requests++;
        group.attempts += attempts;
        if (failure) {
          group.failed++;
          bump(group.errors, code as string);
        } else {
          group.succeeded++;
        }
        if (status !== undefined) bump(group.statusCodes, String(status));
        group.sum += durationMs;
        group.min = Math.min(group.min, durationMs);
        group.max = Math.max(group.max, durationMs);
        const index = buckets.findIndex((bound) => durationMs <= bound);
        const slot = index === -1 ? buckets.length : index;
        group.counts[slot] = (group.counts[slot] as number) + 1;

        emit({
          type: 'request',
          group: groupName,
          method: request.method,
          url: request.url,
          ok: !failure,
          status,
          code,
          attempts,
          durationMs,
        });
      },
      onCircuitStateChange: ({ key, from, to }) => {
        const entry = circuits.get(key) ?? { state: to, opened: 0 };
        entry.state = to;
        if (to === 'open') entry.opened++;
        circuits.set(key, entry);
        emit({ type: 'circuit', key, from, to });
      },
    },
  };
}

import type { Metrics as MetricsSnapshot } from './types.ts';

const empty = (): MetricsSnapshot => ({
  requests: 0,
  inFlight: 0,
  succeeded: 0,
  failed: 0,
  aborted: 0,
  timeouts: 0,
  attempts: 0,
  retries: 0,
  circuitRejections: 0,
  deduped: 0,
  hedges: 0,
  statusCodes: {},
  latency: { count: 0, min: 0, max: 0, avg: 0, last: 0 },
});

export class MetricsStore {
  #data = empty();
  #latencyTotal = 0;

  /** In-flight is a live gauge, so it survives `reset()`. */
  reset(): void {
    const inFlight = this.#data.inFlight;
    this.#data = empty();
    this.#data.inFlight = inFlight;
    this.#latencyTotal = 0;
  }

  inc(
    key:
      | 'requests'
      | 'succeeded'
      | 'failed'
      | 'aborted'
      | 'timeouts'
      | 'attempts'
      | 'retries'
      | 'circuitRejections'
      | 'deduped'
      | 'hedges',
  ): void {
    this.#data[key]++;
  }

  inFlight(delta: 1 | -1): void {
    this.#data.inFlight += delta;
  }

  status(code: number): void {
    const key = String(code);
    this.#data.statusCodes[key] = (this.#data.statusCodes[key] ?? 0) + 1;
  }

  latency(ms: number): void {
    const l = this.#data.latency;
    l.count++;
    this.#latencyTotal += ms;
    l.min = l.count === 1 ? ms : Math.min(l.min, ms);
    l.max = Math.max(l.max, ms);
    l.last = ms;
    l.avg = this.#latencyTotal / l.count;
  }

  snapshot(): MetricsSnapshot {
    return structuredClone(this.#data);
  }
}

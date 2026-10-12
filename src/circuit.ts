import type { CircuitState } from './types.ts';

export interface CircuitSettings {
  failureThreshold: number;
  resetTimeout: number;
  halfOpenMaxRequests: number;
  successThreshold: number;
}

export interface CircuitToken {
  probe: boolean;
  epoch: number;
}

export type Acquire = ({ allowed: true } & CircuitToken) | { allowed: false; retryAfter: number };

/** Timestamp-based breaker: no timers, so nothing can leak or keep a process alive. */
export class CircuitBreaker {
  readonly key: string;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #halfOpenInFlight = 0;
  #halfOpenSuccesses = 0;
  #epoch = 0;
  readonly #settings: CircuitSettings;
  readonly #onChange: (key: string, from: CircuitState, to: CircuitState) => void;

  constructor(
    key: string,
    settings: CircuitSettings,
    onChange: (key: string, from: CircuitState, to: CircuitState) => void,
  ) {
    this.key = key;
    this.#settings = settings;
    this.#onChange = onChange;
  }

  get state(): CircuitState {
    return this.#state;
  }

  #transition(to: CircuitState): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#epoch++;
    this.#failures = 0;
    this.#halfOpenInFlight = 0;
    this.#halfOpenSuccesses = 0;
    if (to === 'open') this.#openedAt = Date.now();
    this.#onChange(this.key, from, to);
  }

  acquire(): Acquire {
    if (this.#state === 'open') {
      const elapsed = Date.now() - this.#openedAt;
      if (elapsed < this.#settings.resetTimeout) {
        return { allowed: false, retryAfter: Math.max(0, Math.ceil(this.#settings.resetTimeout - elapsed)) };
      }
      this.#transition('half-open');
    }
    if (this.#state === 'half-open') {
      if (this.#halfOpenInFlight >= this.#settings.halfOpenMaxRequests) {
        return { allowed: false, retryAfter: 0 };
      }
      this.#halfOpenInFlight++;
      return { allowed: true, probe: true, epoch: this.#epoch };
    }
    return { allowed: true, probe: false, epoch: this.#epoch };
  }

  success(token: CircuitToken): void {
    if (token.epoch !== this.#epoch) return;
    if (token.probe) {
      this.#halfOpenInFlight--;
      this.#halfOpenSuccesses++;
      if (this.#halfOpenSuccesses >= this.#settings.successThreshold) this.#transition('closed');
    } else {
      this.#failures = 0;
    }
  }

  failure(token: CircuitToken): void {
    if (token.epoch !== this.#epoch) return;
    if (token.probe) {
      this.#transition('open');
    } else if (++this.#failures >= this.#settings.failureThreshold) {
      this.#transition('open');
    }
  }

  /** The outcome says nothing about the server's health (e.g. the caller aborted). */
  release(token: CircuitToken): void {
    if (token.epoch === this.#epoch && token.probe) this.#halfOpenInFlight--;
  }

  reset(): void {
    this.#transition('closed');
    this.#failures = 0;
  }
}

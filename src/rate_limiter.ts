type Entry = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export class FixedWindowRateLimiter {
  readonly #entries = new Map<string, Entry>();

  take(
    key: string,
    max: number,
    windowMs: number,
    nowMs: number,
  ): RateLimitResult {
    const entry = this.#entries.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      const resetAt = nowMs + windowMs;
      this.#entries.set(key, { count: 1, resetAt });
      this.#cleanup(nowMs);
      return { allowed: true, remaining: Math.max(0, max - 1), resetAt };
    }

    if (entry.count >= max) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt };
    }

    entry.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, max - entry.count),
      resetAt: entry.resetAt,
    };
  }

  #cleanup(nowMs: number): void {
    if (this.#entries.size < 10_000) {
      return;
    }

    for (const [key, entry] of this.#entries) {
      if (entry.resetAt <= nowMs) {
        this.#entries.delete(key);
      }
    }
  }
}

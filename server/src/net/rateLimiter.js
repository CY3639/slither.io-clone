/**
 * Token bucket per connection. A browser sends input at most ~20 Hz; anything far above the
 * configured rate is dropped, and sustained abuse closes the connection.
 */
export class RateLimiter {
    constructor({ ratePerSecond, burst = ratePerSecond, now = () => Date.now() }) {
        this.rate = ratePerSecond;
        this.capacity = burst;
        this.tokens = burst;
        this.now = now;
        this.last = now();
        this.dropped = 0;
    }

    /** Returns true if the message may be processed. */
    take() {
        const t = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
        this.last = t;
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        this.dropped++;
        return false;
    }
}

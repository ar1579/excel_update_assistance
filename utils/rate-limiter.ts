/**
 * Rate limiter utility for API calls
 * Helps prevent exceeding API rate limits by controlling request frequency
 */

/**
 * Creates a rate limiter that ensures requests don't exceed a specified rate
 * @param requestsPerMinute Maximum number of requests allowed per minute
 * @returns A function that handles rate limiting
 */
export function createRateLimiter(requestsPerMinute: number) {
    // Calculate delay between requests in milliseconds
    const minDelayMs = (60 * 1000) / requestsPerMinute;

    // Track the timestamps of recent requests
    const requestTimestamps: number[] = [];

    /**
     * Waits until it's safe to make another request based on the rate limit
     * @returns A promise that resolves when it's safe to proceed with the next request
     */
    async function waitForNextRequest(): Promise<void> {
        const now = Date.now();

        // Remove timestamps older than 1 minute
        const oneMinuteAgo = now - 60 * 1000;
        while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
            requestTimestamps.shift();
        }

        // If we haven't hit the rate limit, proceed immediately
        if (requestTimestamps.length < requestsPerMinute) {
            requestTimestamps.push(now);
            return;
        }

        // Calculate how long to wait before the next request
        const oldestTimestamp = requestTimestamps[0];
        const timeToWait = Math.max(oldestTimestamp + 60 * 1000 - now, minDelayMs);

        // Wait for the calculated time
        await new Promise(resolve => setTimeout(resolve, timeToWait));

        // Remove the oldest timestamp and add the current one
        requestTimestamps.shift();
        requestTimestamps.push(Date.now());
    }

    /**
     * Executes a function with rate limiting
     * @param fn The function to execute
     * @returns The result of the function
     */
    async function executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
        await waitForNextRequest();
        return await fn();
    }

    return {
        waitForNextRequest,
        executeWithRateLimit
    };
}

/**
 * Simple sleep function for adding delays
 * @param ms Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
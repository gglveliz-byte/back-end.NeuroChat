const Queue = require('bull');

// ─── Redis connection for Bull queues ───────────────────────────
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Configure redis options natively for Bull connecting to Upstash
const redisOpts = {};
if (REDIS_URL.startsWith('rediss://')) {
    redisOpts.tls = {
        rejectUnauthorized: false
    };
    redisOpts.enableTLSForSentinelMode = false;
}

/**
 * Create a Bull queue with default configuration.
 * IMPORTANT: retryStrategy stops after 5 failures to avoid burning Upstash free-tier limits.
 * @param {string} name - Queue name
 * @returns {Queue} Bull queue instance
 */
function createQueue(name) {
    const queue = new Queue(name, REDIS_URL, {
        redis: {
            ...redisOpts,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                // STOP retrying after 5 attempts — prevents burning Upstash request limits
                if (times > 5) {
                    console.error(`[Redis] Giving up after ${times} retries for queue "${name}". Using in-memory fallback.`);
                    return null; // null = stop retrying
                }
                return Math.min(times * 3000, 15000);
            },
            reconnectOnError: (err) => {
                // Only reconnect on connection errors, NOT on limit errors
                const msg = err.message || '';
                if (msg.includes('max requests limit') || msg.includes('READONLY')) {
                    return false; // Don't reconnect — limit exhausted
                }
                return true;
            }
        },
        defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 50,
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000
            }
        }
    });

    // Silence Redis errors — the queue fallback handles everything
    queue.on('error', () => {});

    queue.on('failed', (job, error) => {
        console.error(`[Redis] Job ${job.id} in "${name}" failed:`, error.message);
    });

    return queue;
}

/**
 * Check if Redis is available (one-shot, no retries)
 * @returns {Promise<boolean>}
 */
async function checkRedisConnection() {
    try {
        const Redis = require('ioredis');
        const client = new Redis(REDIS_URL, {
            ...redisOpts,
            maxRetriesPerRequest: 1,
            retryStrategy: () => null, // Don't retry during health check
            lazyConnect: true,
        });
        client.on('error', () => {}); // Suppress errors during check

        await client.connect();
        await Promise.race([
            client.ping(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 5000))
        ]);
        await client.quit().catch(() => {});
        return true;
    } catch (error) {
        const msg = error.message || '';
        if (msg.includes('max requests limit')) {
            console.warn('[Redis] Upstash límite alcanzado — usando cola en memoria.');
        } else {
            console.warn(`[Redis] No disponible: ${msg}`);
        }
        return false;
    }
}

module.exports = { createQueue, checkRedisConnection, REDIS_URL };

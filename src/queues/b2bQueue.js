const { createQueue, checkRedisConnection } = require('../config/redis');
const { query } = require('../config/database');
const { stepTranscribe, stepFilter, stepAnalyze, stepReprocess, stepSelectiveReprocess } = require('../services/b2bPipelineService');

// Map job name → status to set on interaction when job fails (after all retries)
const FAILED_STATUS_BY_JOB = {
  transcribe: 'error_transcripcion',
  filter: 'error_filtro',
  analyze: 'error_analisis',
  reprocess: 'error_reproceso',
  selective_reprocess: 'error_reproceso'
};

// ─── B2B Pipeline Queue ─────────────────────────────────────────
// Uses Bull (Redis) when available, falls back to in-memory queue.
// In-memory queue processes jobs sequentially with concurrency control
// to prevent server overload when uploading many audios.

let b2bQueue = null;
let isReady = false;
let useMemoryQueue = false;

// ─── In-Memory Queue (fallback when Redis unavailable) ──────────
const memoryQueue = [];
let memoryProcessing = false;
const MEMORY_CONCURRENCY = { transcribe: 1, filter: 2, analyze: 2, reprocess: 1 };
const activeJobs = { transcribe: 0, filter: 0, analyze: 0, reprocess: 0, selective_reprocess: 0 };

async function processMemoryJob(job) {
  const { name, data } = job;
  const interactionId = data.interactionId;

  try {
    activeJobs[name]++;
    console.log(`[B2B Queue:Memory] Processing ${name} for ${interactionId}...`);

    switch (name) {
      case 'transcribe':
        await stepTranscribe(interactionId, data.audioUrl, data.quality);
        await addJob('filter', { interactionId });
        break;
      case 'filter':
        await stepFilter(interactionId);
        await addJob('analyze', { interactionId });
        break;
      case 'analyze':
        await stepAnalyze(interactionId);
        break;
      case 'reprocess':
        await stepReprocess(interactionId, data.humanFeedback);
        break;
      case 'selective_reprocess':
        await stepSelectiveReprocess(interactionId, data.lockedCriteriaIds, data.correctionCriteria);
        break;
    }

    console.log(`[B2B Queue:Memory] ${name} completed for ${interactionId}`);
  } catch (err) {
    console.error(`[B2B Queue:Memory] ${name} failed for ${interactionId}:`, err.message);

    // Retry up to 3 times
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts < 3) {
      console.log(`[B2B Queue:Memory] Retrying ${name} (attempt ${job.attempts + 1}/3)...`);
      memoryQueue.push(job);
    } else {
      // Mark interaction as failed
      const status = FAILED_STATUS_BY_JOB[name];
      if (status && interactionId) {
        try {
          await query("UPDATE b2b_interactions SET status = $1 WHERE id = $2", [status, interactionId]);
        } catch { /* ignore */ }
      }
    }
  } finally {
    activeJobs[name]--;
  }
}

async function drainMemoryQueue() {
  if (memoryProcessing) return;
  memoryProcessing = true;

  try {
    while (memoryQueue.length > 0) {
      // Find next job that has available concurrency
      let jobIndex = -1;
      for (let i = 0; i < memoryQueue.length; i++) {
        const name = memoryQueue[i].name;
        if (activeJobs[name] < (MEMORY_CONCURRENCY[name] || 1)) {
          jobIndex = i;
          break;
        }
      }

      if (jobIndex === -1) {
        // All job types are at max concurrency, wait a bit
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const job = memoryQueue.splice(jobIndex, 1)[0];
      await processMemoryJob(job);
    }
  } finally {
    memoryProcessing = false;
  }
}

// ─── Bull Queue (Redis) ─────────────────────────────────────────

async function initB2BQueue() {
  // ─── Step 1: Check if Redis is available BEFORE creating Bull ───
  // This prevents ioredis from throwing uncaught auth errors that crash the process
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) {
    console.log('[B2B Queue] No REDIS_URL configured — using in-memory queue');
    useMemoryQueue = true;
    isReady = true;
    return null;
  }

  const redisAvailable = await checkRedisConnection();
  if (!redisAvailable) {
    console.warn('[B2B Queue] Redis not available — using in-memory queue');
    useMemoryQueue = true;
    isReady = true;
    return null;
  }

  try {
    b2bQueue = createQueue('b2b-pipeline');

    // ─── Processors ───────────────────────────────────────────
    b2bQueue.process('transcribe', 1, async (job) => {
      const { interactionId, audioUrl, quality } = job.data;
      await stepTranscribe(interactionId, audioUrl, quality);
      await addJob('filter', { interactionId });
      return { step: 'transcribe', interactionId };
    });

    b2bQueue.process('filter', 2, async (job) => {
      const { interactionId } = job.data;
      await stepFilter(interactionId);
      await addJob('analyze', { interactionId });
      return { step: 'filter', interactionId };
    });

    b2bQueue.process('analyze', 2, async (job) => {
      const { interactionId } = job.data;
      await stepAnalyze(interactionId);
      return { step: 'analyze', interactionId };
    });

    b2bQueue.process('reprocess', 1, async (job) => {
      const { interactionId, humanFeedback } = job.data;
      await stepReprocess(interactionId, humanFeedback);
      return { step: 'reprocess', interactionId };
    });

    b2bQueue.process('selective_reprocess', 1, async (job) => {
      const { interactionId, lockedCriteriaIds, correctionCriteria } = job.data;
      await stepSelectiveReprocess(interactionId, lockedCriteriaIds, correctionCriteria);
      return { step: 'selective_reprocess', interactionId };
    });

    // ─── Events (throttled) ─────────────────────────────────
    b2bQueue.on('completed', (job, result) => {
      console.log(`[B2B Queue] Job ${job.id} (${job.name}) completed:`, result);
    });

    let lastFailLog = 0;
    b2bQueue.on('failed', async (job, err) => {
      const now = Date.now();
      if (now - lastFailLog > 10000) {
        console.error(`[B2B Queue] Job ${job.id} (${job.name}) failed:`, err.message);
        lastFailLog = now;
      }
      const interactionId = job.data?.interactionId;
      const status = FAILED_STATUS_BY_JOB[job.name];
      if (interactionId && status) {
        try {
          await query("UPDATE b2b_interactions SET status = $1 WHERE id = $2", [status, interactionId]);
        } catch { /* ignore */ }
      }
    });

    b2bQueue.on('ready', () => {
      isReady = true;
      useMemoryQueue = false;
      console.log('[B2B Queue] Connected to Redis and ready');
    });

    // Throttle error logs — max 1 per 60s
    let lastErrorLog = 0;
    let errorCount = 0;
    b2bQueue.on('error', (err) => {
      errorCount++;
      const now = Date.now();
      if (now - lastErrorLog > 60000) {
        console.error(`[B2B Queue] Redis error (${errorCount}x): ${err.message}`);
        lastErrorLog = now;
        errorCount = 0;

        // If limit exceeded, switch to memory queue gracefully
        if (err.message && err.message.includes('max requests limit')) {
          console.warn('[B2B Queue] Upstash limit reached — switching to in-memory queue');
          useMemoryQueue = true;
          isReady = false;
          // Close Bull to stop retrying — don't let it throw
          try { b2bQueue.close().catch(() => {}); } catch { /* ignore */ }
          b2bQueue = null;
        }
      }
    });

    return b2bQueue;
  } catch (err) {
    console.error('[B2B Queue] Failed to initialize:', err.message);
    console.warn('[B2B Queue] Using in-memory queue fallback');
    useMemoryQueue = true;
    isReady = true;
    return null;
  }
}

/**
 * Add a job to the B2B queue (Redis or in-memory fallback)
 * @param {string} name - Job type: 'transcribe' | 'filter' | 'analyze' | 'reprocess'
 * @param {Object} data - Job payload
 */
async function addJob(name, data) {
  // Try Bull queue first
  if (b2bQueue && isReady && !useMemoryQueue) {
    try {
      const job = await b2bQueue.add(name, data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 }
      });
      console.log(`[B2B Queue] Job ${job.id} (${name}) added to Redis`);
      return job;
    } catch (addErr) {
      console.warn(`[B2B Queue] Failed to add job to Redis: ${addErr.message}, using memory fallback`);
    }
  }

  // Fallback: in-memory queue
  const memJob = { name, data, attempts: 0, id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
  memoryQueue.push(memJob);
  console.log(`[B2B Queue:Memory] Job ${memJob.id} (${name}) queued (${memoryQueue.length} pending)`);

  // Start draining if not already running
  setImmediate(() => drainMemoryQueue());

  return memJob;
}

function isQueueReady() {
  // Queue is always "ready" — either Redis or memory fallback
  return true;
}

async function closeQueue() {
  if (b2bQueue) {
    await b2bQueue.close();
    console.log('[B2B Queue] Closed');
  }

  if (useMemoryQueue) {
    let waitAttempts = 0;
    while (memoryQueue.length > 0 || Object.values(activeJobs).some(count => count > 0)) {
      if (waitAttempts === 0) {
        console.log('[B2B Queue:Memory] Esperando a que terminen los trabajos activos antes de apagar...');
      }
      await new Promise(r => setTimeout(r, 1000));
      waitAttempts++;
      if (waitAttempts >= 25) {
        console.warn('[B2B Queue:Memory] Timeout de 25s alcanzado. Forzando cierre.');
        break;
      }
    }
    if (waitAttempts > 0 && waitAttempts < 25) {
      console.log('[B2B Queue:Memory] Shutdown graceful completado, trabajos finalizados.');
    }
  }
}

function getQueueStats() {
  return {
    mode: useMemoryQueue ? 'memory' : (isReady ? 'redis' : 'initializing'),
    pendingMemoryJobs: memoryQueue.length,
    activeJobs: { ...activeJobs }
  };
}

module.exports = { initB2BQueue, addJob, isQueueReady, closeQueue, getQueueStats };

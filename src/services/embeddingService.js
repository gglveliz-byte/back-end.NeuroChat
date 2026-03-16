/**
 * Embedding Service — RAG (Retrieval-Augmented Generation)
 *
 * Responsibilities:
 * 1. chunkText()          — split document into overlapping word-chunks
 * 2. generateEmbedding()  — call OpenAI text-embedding-3-small
 * 3. indexKnowledgeFile() — chunk + embed + store in knowledge_chunks
 * 4. searchRelevantChunks() — cosine similarity search for a user query
 * 5. reindexClientFiles() — re-index all files of a client (admin tool)
 */

const OpenAI = require('openai');
const { query } = require('../config/database');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims — cheapest, excellent quality
const CHUNK_SIZE = 400;  // words per chunk (~600-800 tokens)
const CHUNK_OVERLAP = 50; // words of overlap between adjacent chunks
const MIN_SIMILARITY = 0.30; // discard chunks below this cosine similarity
const BATCH_SIZE = 10; // embeddings per API call batch

// Cache: is pgvector available on this DB?
let _pgvectorAvailable = null;

/**
 * Checks once whether the pgvector extension is installed.
 * Result is cached for the lifetime of the process.
 */
const isPgvectorAvailable = async () => {
  if (_pgvectorAvailable !== null) return _pgvectorAvailable;
  try {
    await query("SELECT 'test'::vector(1)");
    _pgvectorAvailable = true;
  } catch {
    console.warn('[RAG] pgvector extension NOT available — RAG indexing/search disabled. Install pgvector on your PostgreSQL to enable.');
    _pgvectorAvailable = false;
  }
  return _pgvectorAvailable;
};

// =====================================================
// TEXT CHUNKING
// =====================================================

/**
 * Splits text into overlapping word-based chunks.
 * Strategy: split by whitespace → slide a window of CHUNK_SIZE words with CHUNK_OVERLAP overlap.
 *
 * @param {string} text        — raw extracted text from PDF/TXT
 * @param {number} chunkSize   — words per chunk
 * @param {number} overlap     — overlapping words between consecutive chunks
 * @returns {string[]}         — array of text chunks
 */
const chunkText = (text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) => {
  if (!text || text.trim().length === 0) return [];

  // Normalize whitespace
  const words = text.replace(/\n+/g, ' ').split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  const chunks = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    const content = words.slice(start, end).join(' ');

    if (content.trim().length > 20) { // skip near-empty chunks
      chunks.push(content);
    }

    if (end >= words.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
};

// =====================================================
// EMBEDDING GENERATION
// =====================================================

/**
 * Generates a vector embedding for a given text using OpenAI.
 * @param {string} text — input text (truncated to 8000 chars to stay within limits)
 * @returns {number[]}  — 1536-dimension float array
 */
const generateEmbedding = async (text) => {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // ~6000 tokens max
  });
  return response.data[0].embedding;
};

// =====================================================
// INDEXING
// =====================================================

/**
 * Indexes a knowledge file into knowledge_chunks table.
 * - Chunks the full text
 * - Generates embeddings in batches (rate-limit friendly)
 * - Upserts into knowledge_chunks (deletes existing chunks first)
 *
 * Called asynchronously after a file is uploaded — failure does NOT break the upload.
 *
 * @param {string} fileId    — UUID of the client_knowledge_files row
 * @param {string} clientId  — UUID of the client
 * @param {string} text      — full extracted text
 * @param {string} filename  — human-readable filename (for logging)
 */
const indexKnowledgeFile = async (fileId, clientId, text, filename) => {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[RAG] Skipping indexing: OPENAI_API_KEY not configured');
    return;
  }

  if (!(await isPgvectorAvailable())) {
    console.warn(`[RAG] Skipping indexing "${filename}": pgvector not available`);
    return;
  }

  try {
    // Remove any existing chunks for this file (handles re-uploads)
    await query('DELETE FROM knowledge_chunks WHERE file_id = $1', [fileId]);

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      console.warn(`[RAG] No chunks generated for ${filename}`);
      return;
    }

    console.log(`[RAG] Indexing ${chunks.length} chunks for "${filename}" (${fileId})`);

    // Process in batches to avoid OpenAI rate limits
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      // Generate all embeddings in the batch concurrently
      const embeddings = await Promise.all(batch.map(chunk => generateEmbedding(chunk)));

      // Insert each chunk + embedding into DB
      for (let j = 0; j < batch.length; j++) {
        const chunkIndex = i + j;
        const embeddingStr = `[${embeddings[j].join(',')}]`;

        await query(
          `INSERT INTO knowledge_chunks (client_id, file_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [clientId, fileId, chunkIndex, batch[j], embeddingStr]
        );
      }
    }

    console.log(`[RAG] Done indexing "${filename}": ${chunks.length} chunks stored`);

  } catch (error) {
    // Soft failure — don't crash the upload flow
    console.error(`[RAG] Error indexing "${filename}":`, error.message);
  }
};

// =====================================================
// SIMILARITY SEARCH
// =====================================================

/**
 * Searches the knowledge_chunks table for the most relevant chunks
 * given a user's message, using cosine similarity.
 *
 * @param {string} userQuery  — the user's latest message
 * @param {string} clientId   — UUID of the client
 * @param {number} limit      — max number of chunks to return
 * @returns {Array<{content: string, filename: string, similarity: number}>}
 */
const searchRelevantChunks = async (userQuery, clientId, limit = 5) => {
  if (!process.env.OPENAI_API_KEY || !userQuery || !clientId) return [];
  if (!(await isPgvectorAvailable())) return [];

  try {
    // Fast check: does this client have any indexed chunks?
    const countResult = await query(
      'SELECT COUNT(*) AS total FROM knowledge_chunks WHERE client_id = $1',
      [clientId]
    );
    if (parseInt(countResult.rows[0].total) === 0) return [];

    // Embed the user query
    const queryEmbedding = await generateEmbedding(userQuery);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Cosine similarity search: <=> is the pgvector cosine distance operator
    // similarity = 1 - distance
    const result = await query(
      `SELECT
         kc.content,
         kf.filename,
         ROUND((1 - (kc.embedding <=> $1::vector))::numeric, 4) AS similarity
       FROM knowledge_chunks kc
       JOIN client_knowledge_files kf ON kc.file_id = kf.id
       WHERE kc.client_id = $2
         AND (1 - (kc.embedding <=> $1::vector)) > $3
       ORDER BY kc.embedding <=> $1::vector
       LIMIT $4`,
      [embeddingStr, clientId, MIN_SIMILARITY, limit]
    );

    return result.rows;

  } catch (error) {
    console.error('[RAG] Error searching chunks:', error.message);
    return [];
  }
};

// =====================================================
// ADMIN UTILITY
// =====================================================

/**
 * Re-indexes ALL knowledge files for a client.
 * Useful when: files existed before RAG was enabled, or after model change.
 *
 * @param {string} clientId
 * @returns {{ indexed: number }}
 */
const reindexClientFiles = async (clientId) => {
  const files = await query(
    'SELECT id, filename, extracted_text FROM client_knowledge_files WHERE client_id = $1',
    [clientId]
  );

  let indexed = 0;
  for (const file of files.rows) {
    if (file.extracted_text) {
      await indexKnowledgeFile(file.id, clientId, file.extracted_text, file.filename);
      indexed++;
    }
  }

  return { indexed };
};

module.exports = {
  chunkText,
  generateEmbedding,
  indexKnowledgeFile,
  searchRelevantChunks,
  reindexClientFiles,
};

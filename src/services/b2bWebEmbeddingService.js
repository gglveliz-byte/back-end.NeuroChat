/**
 * B2B Web Embedding Service
 * 
 * RAG pipeline for the Agente Web module.
 * Reuses the pattern from embeddingService.js but works with
 * b2b_web_knowledge_chunks table and b2b client's own API key.
 */

const OpenAI = require('openai');
const { query } = require('../config/database');
const { decrypt } = require('../utils/encryption');

const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 50;
const MIN_SIMILARITY = 0.30;
const BATCH_SIZE = 10;

// Cache: is pgvector available on this DB?
let _pgvectorAvailable = null;
const isPgvectorAvailable = async () => {
  if (_pgvectorAvailable !== null) return _pgvectorAvailable;
  try {
    await query("SELECT 'test'::vector(1)");
    _pgvectorAvailable = true;
  } catch {
    console.warn('[B2B Web RAG] pgvector extension NOT available — RAG disabled');
    _pgvectorAvailable = false;
  }
  return _pgvectorAvailable;
};

/**
 * Get an OpenAI client using the B2B client's own API key.
 */
async function getClientOpenAI(b2bClientId) {
    const result = await query(
        'SELECT ai_api_key, ai_provider FROM b2b_clients WHERE id = $1',
        [b2bClientId]
    );
    if (!result.rows[0] || !result.rows[0].ai_api_key) {
        // Fallback to platform API key
        return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    const apiKey = decrypt(result.rows[0].ai_api_key);
    return new OpenAI({ apiKey });
}

/**
 * Split text into overlapping word-based chunks.
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    if (!text || text.trim().length === 0) return [];
    const words = text.replace(/\n+/g, ' ').split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return [];

    const chunks = [];
    let start = 0;

    while (start < words.length) {
        const end = Math.min(start + chunkSize, words.length);
        const content = words.slice(start, end).join(' ');
        if (content.trim().length > 20) chunks.push(content);
        if (end >= words.length) break;
        start += chunkSize - overlap;
    }

    return chunks;
}

/**
 * Generate embedding using the client's API key.
 */
async function generateEmbedding(openai, text) {
    const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text.slice(0, 8000),
    });
    return response.data[0].embedding;
}

/**
 * Index scraped content into b2b_web_knowledge_chunks.
 * Deletes existing chunks for the scrape URL, then re-indexes.
 * 
 * @param {string} b2bClientId
 * @param {string} scrapeUrlId
 * @param {string} text — full extracted text
 */
async function indexScrapedContent(b2bClientId, scrapeUrlId, text) {
    if (!(await isPgvectorAvailable())) {
        console.warn(`[B2B Web RAG] Skipping indexing: pgvector not available`);
        return { indexed: 0 };
    }
    const openai = await getClientOpenAI(b2bClientId);

    try {
        // Remove existing chunks for this URL
        await query(
            'DELETE FROM b2b_web_knowledge_chunks WHERE scrape_url_id = $1',
            [scrapeUrlId]
        );

        const chunks = chunkText(text);
        if (chunks.length === 0) {
            console.warn(`[B2B Web RAG] No chunks generated for URL ${scrapeUrlId}`);
            return { indexed: 0 };
        }

        console.log(`[B2B Web RAG] Indexing ${chunks.length} chunks for URL ${scrapeUrlId}`);

        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batch = chunks.slice(i, i + BATCH_SIZE);
            const embeddings = await Promise.all(
                batch.map(chunk => generateEmbedding(openai, chunk))
            );

            for (let j = 0; j < batch.length; j++) {
                const chunkIndex = i + j;
                const embeddingStr = `[${embeddings[j].join(',')}]`;

                await query(
                    `INSERT INTO b2b_web_knowledge_chunks (b2b_client_id, scrape_url_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
                    [b2bClientId, scrapeUrlId, chunkIndex, batch[j], embeddingStr]
                );
            }
        }

        console.log(`[B2B Web RAG] Done: ${chunks.length} chunks stored for URL ${scrapeUrlId}`);
        return { indexed: chunks.length };

    } catch (error) {
        console.error(`[B2B Web RAG] Error indexing URL ${scrapeUrlId}:`, error.message);
        throw error;
    }
}

/**
 * Search relevant knowledge chunks for a user query (cosine similarity).
 * 
 * @param {string} userQuery
 * @param {string} b2bClientId
 * @param {number} limit
 * @returns {Promise<Array<{content: string, similarity: number}>>}
 */
async function searchRelevantChunks(userQuery, b2bClientId, limit = 5) {
    if (!(await isPgvectorAvailable())) return [];
    const openai = await getClientOpenAI(b2bClientId);

    try {
        // Fast check
        const countResult = await query(
            'SELECT COUNT(*) AS total FROM b2b_web_knowledge_chunks WHERE b2b_client_id = $1',
            [b2bClientId]
        );
        if (parseInt(countResult.rows[0].total) === 0) return [];

        const queryEmbedding = await generateEmbedding(openai, userQuery);
        const embeddingStr = `[${queryEmbedding.join(',')}]`;

        const result = await query(
            `SELECT
         kc.content,
         ROUND((1 - (kc.embedding <=> $1::vector))::numeric, 4) AS similarity
       FROM b2b_web_knowledge_chunks kc
       WHERE kc.b2b_client_id = $2
         AND (1 - (kc.embedding <=> $1::vector)) > $3
       ORDER BY kc.embedding <=> $1::vector
       LIMIT $4`,
            [embeddingStr, b2bClientId, MIN_SIMILARITY, limit]
        );

        return result.rows;

    } catch (error) {
        console.error('[B2B Web RAG] Search error:', error.message);
        return [];
    }
}

/**
 * Re-index ALL scraped content for a client.
 */
async function reindexAllForClient(b2bClientId) {
    const contents = await query(
        `SELECT sc.extracted_text, su.id as scrape_url_id
     FROM b2b_web_scraped_content sc
     JOIN b2b_web_scrape_urls su ON sc.scrape_url_id = su.id
     WHERE sc.b2b_client_id = $1 AND sc.extracted_text IS NOT NULL`,
        [b2bClientId]
    );

    let indexed = 0;
    for (const row of contents.rows) {
        const result = await indexScrapedContent(b2bClientId, row.scrape_url_id, row.extracted_text);
        indexed += result.indexed;
    }

    return { indexed };
}

/**
 * Fallback: return raw scraped text chunks (no embeddings, no pgvector needed).
 * Used when pgvector is not available on the database.
 */
async function getScrapedTextFallback(b2bClientId, limit = 3) {
    try {
        const result = await query(
            `SELECT sc.extracted_text
       FROM b2b_web_scraped_content sc
       WHERE sc.b2b_client_id = $1 AND sc.extracted_text IS NOT NULL
       ORDER BY sc.scraped_at DESC
       LIMIT 5`,
            [b2bClientId]
        );

        if (result.rows.length === 0) return [];

        // Combine all scraped text and chunk it
        const fullText = result.rows.map(r => r.extracted_text).join('\n\n');
        const chunks = chunkText(fullText, 600, 50);

        // Return first N chunks as fake "RAG results"
        return chunks.slice(0, limit).map(content => ({ content, similarity: 1.0 }));
    } catch (error) {
        console.error('[B2B Web RAG] Fallback text error:', error.message);
        return [];
    }
}

/**
 * Index an uploaded file's text into b2b_web_knowledge_chunks.
 * Uses file_id as scrape_url_id (reusing the same column for both sources).
 *
 * @param {string} b2bClientId
 * @param {string} fileId - UUID of the uploaded file
 * @param {string} text - extracted text from the file
 */
async function indexUploadedFile(b2bClientId, fileId, text) {
    if (!(await isPgvectorAvailable())) {
        console.warn(`[B2B Web RAG] Skipping file indexing: pgvector not available`);
        return { indexed: 0 };
    }
    const openai = await getClientOpenAI(b2bClientId);

    try {
        // Remove existing chunks for this file
        await query(
            'DELETE FROM b2b_web_knowledge_chunks WHERE scrape_url_id = $1',
            [fileId]
        );

        const chunks = chunkText(text);
        if (chunks.length === 0) {
            console.warn(`[B2B Web RAG] No chunks generated for file ${fileId}`);
            return { indexed: 0 };
        }

        console.log(`[B2B Web RAG] Indexing ${chunks.length} chunks for uploaded file ${fileId}`);

        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
            const batch = chunks.slice(i, i + BATCH_SIZE);
            const embeddings = await Promise.all(
                batch.map(chunk => generateEmbedding(openai, chunk))
            );

            for (let j = 0; j < batch.length; j++) {
                const chunkIndex = i + j;
                const embeddingStr = `[${embeddings[j].join(',')}]`;

                await query(
                    `INSERT INTO b2b_web_knowledge_chunks (b2b_client_id, scrape_url_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
                    [b2bClientId, fileId, chunkIndex, batch[j], embeddingStr]
                );
            }
        }

        console.log(`[B2B Web RAG] Done: ${chunks.length} chunks stored for file ${fileId}`);
        return { indexed: chunks.length };

    } catch (error) {
        console.error(`[B2B Web RAG] Error indexing file ${fileId}:`, error.message);
        throw error;
    }
}

/**
 * Fallback: return raw uploaded file text chunks (no embeddings).
 * Used when pgvector is not available on the database.
 */
async function getUploadedTextFallback(b2bClientId, limit = 3) {
    try {
        const result = await query(
            `SELECT extracted_text FROM b2b_web_uploaded_files
             WHERE b2b_client_id = $1 AND extracted_text IS NOT NULL AND status = 'done'
             ORDER BY created_at DESC LIMIT 5`,
            [b2bClientId]
        );
        if (result.rows.length === 0) return [];

        const fullText = result.rows.map(r => r.extracted_text).join('\n\n');
        const chunks = chunkText(fullText, 600, 50);
        return chunks.slice(0, limit).map(content => ({ content, similarity: 1.0 }));
    } catch (error) {
        console.error('[B2B Web RAG] Uploaded text fallback error:', error.message);
        return [];
    }
}

module.exports = {
    chunkText,
    indexScrapedContent,
    indexUploadedFile,
    searchRelevantChunks,
    reindexAllForClient,
    getClientOpenAI,
    getScrapedTextFallback,
    getUploadedTextFallback,
};

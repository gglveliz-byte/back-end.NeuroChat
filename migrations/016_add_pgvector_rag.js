/**
 * Migration 016: pgvector + knowledge_chunks table
 * Enables RAG (Retrieval-Augmented Generation) for knowledge files
 */
const { query } = require('../src/config/database');

async function run() {
  console.log('🔧 Migration 016: pgvector + knowledge_chunks (RAG)...');

  // Enable pgvector extension
  try {
    await query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('  ✅ pgvector extension enabled');
  } catch (e) {
    console.warn('  ⚠️  pgvector extension not available (host may not support it):', e.message);
    console.warn('  ⚠️  RAG features will be disabled. Knowledge files will still be stored but vector search won\'t work.');
    return; // Skip rest of migration — no vector type means we can't create the table
  }

  // Create knowledge_chunks table
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        file_id       UUID NOT NULL REFERENCES client_knowledge_files(id) ON DELETE CASCADE,
        chunk_index   INTEGER NOT NULL,
        content       TEXT NOT NULL,
        embedding     vector(1536),
        created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
    console.log('  ✅ knowledge_chunks table created');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('  ⏭️  knowledge_chunks table already exists');
    } else {
      throw e;
    }
  }

  // Index for client-scoped lookup
  try {
    await query(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_client_id
      ON knowledge_chunks(client_id)
    `);
    console.log('  ✅ Index on client_id created');
  } catch (e) {
    console.error('  ⚠️  Index client_id:', e.message);
  }

  // Index for file-scoped lookup (re-indexing)
  try {
    await query(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_file_id
      ON knowledge_chunks(file_id)
    `);
    console.log('  ✅ Index on file_id created');
  } catch (e) {
    console.error('  ⚠️  Index file_id:', e.message);
  }

  // HNSW vector index for cosine similarity search
  try {
    await query(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
    console.log('  ✅ HNSW vector index created');
  } catch (e) {
    // HNSW may not be available in older pgvector versions — fall back silently
    console.warn('  ⚠️  HNSW index skipped (older pgvector?):', e.message);
    try {
      await query(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding
        ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 10)
      `);
      console.log('  ✅ IVFFlat fallback vector index created');
    } catch (e2) {
      console.warn('  ⚠️  Vector index skipped:', e2.message);
    }
  }

  console.log('✅ Migration 016 completed: RAG infrastructure ready');
}

module.exports = { up: run, run };

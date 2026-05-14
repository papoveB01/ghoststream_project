-- Enable pgvector for the Knowledge Base RAG layer.
-- This file is executed by the postgres container ONLY on first volume
-- initialization (i.e. when /var/lib/postgresql/data is empty). For brownfield
-- deployments where the volume already exists, the migration runner in
-- api/db/migrate.js issues `CREATE EXTENSION IF NOT EXISTS vector` as well,
-- so this is just an early hint for fresh databases.
CREATE EXTENSION IF NOT EXISTS vector;

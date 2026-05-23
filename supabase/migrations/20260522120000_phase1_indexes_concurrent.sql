-- =============================================================================
-- Phase 1.1 — Foreign-key covering indexes (zero-downtime)
-- =============================================================================
-- Cria índices nas 4 FKs sem cobertura identificadas pelo advisor de performance.
-- TODOS os índices são criados com CONCURRENTLY: não pega lock de escrita.
--
-- ⚠️  IMPORTANTE — como aplicar:
--   1. Tirar snapshot/backup do projeto ANTES de rodar
--   2. Cada CREATE INDEX CONCURRENTLY deve ser executado em SUA PRÓPRIA
--      transação. NÃO envolver em BEGIN/COMMIT explícito e NÃO rodar
--      via `apply_migration` (que abre transação automática) — preferir
--      executar via psql conectado ao pooler (porta 5432, não 6543),
--      ou via Supabase Dashboard → SQL Editor um a um.
--   3. Se algum CREATE falhar pela metade, vai aparecer índice INVALID em
--      pg_indexes. Verificar com:
--        SELECT indexrelid::regclass, indisvalid FROM pg_index
--        WHERE NOT indisvalid;
--      Se aparecer, dropar e recriar:
--        DROP INDEX CONCURRENTLY public.idx_xxx;
--
-- Impacto esperado: nenhum em latência, nenhum em locks de tabela.
-- =============================================================================

-- assinaturas.plano_id (FK assinaturas_plano_id_fkey)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_assinaturas_plano
  ON public.assinaturas (plano_id);

-- disparos_log.chave_api_id (FK disparos_log_chave_api_id_fkey)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disparos_log_chave_api
  ON public.disparos_log (chave_api_id);

-- disparos_log.grupo_destino_id (FK disparos_log_grupo_destino_id_fkey)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disparos_log_grupo_destino
  ON public.disparos_log (grupo_destino_id);

-- disparos_log.instancia_id (FK disparos_log_instancia_id_fkey)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_disparos_log_instancia
  ON public.disparos_log (instancia_id);

-- =============================================================================
-- Verificação pós-execução (rodar manualmente):
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname='public'
--     AND indexname IN (
--       'idx_assinaturas_plano',
--       'idx_disparos_log_chave_api',
--       'idx_disparos_log_grupo_destino',
--       'idx_disparos_log_instancia'
--     );
-- Esperado: 4 linhas.
-- =============================================================================

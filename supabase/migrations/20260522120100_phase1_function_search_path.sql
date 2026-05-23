-- =============================================================================
-- Phase 1.2 — Fix mutable search_path on public functions
-- =============================================================================
-- Hardening contra search_path injection: fixa search_path nas 4 funções
-- detectadas pelo advisor (`function_search_path_mutable`).
--
-- Nenhuma é SECURITY DEFINER hoje, então o risco real é baixo — mas custo zero.
--
-- search_path = pg_catalog, public:
--   - pg_catalog primeiro impede shadowing de funções built-in via tabelas/types
--     em schemas controlados pelo atacante
--   - public garante que referências unqualified continuem resolvendo
--
-- ⚠️  IMPORTANTE — como aplicar:
--   1. Tirar snapshot ANTES
--   2. Pode ser aplicado em transação única (ALTER FUNCTION é DDL leve)
--   3. SEGURO em produção: ALTER FUNCTION ... SET ... só ajusta GUC, não
--      reescreve o corpo da função e não invalida triggers
--
-- Reversão (se necessária):
--   ALTER FUNCTION public.<nome>(<args>) RESET search_path;
-- =============================================================================

BEGIN;

ALTER FUNCTION public.update_updated_at()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.buscar_telefones_por_plano(p_plano_id uuid)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.limpar_mensagem()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.increment_mensagens(grupo_id uuid)
  SET search_path = pg_catalog, public;

COMMIT;

-- =============================================================================
-- Verificação pós-execução:
--   SELECT proname, proconfig FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public'
--     AND proname IN ('update_updated_at','buscar_telefones_por_plano',
--                     'limpar_mensagem','increment_mensagens');
-- Esperado: proconfig contém 'search_path=pg_catalog, public' para todas.
-- =============================================================================

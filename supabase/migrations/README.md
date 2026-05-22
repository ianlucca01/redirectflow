# Migrations RedirectFlow

Cada migration aqui foi preparada **para ser revisada antes de aplicar**.
Nada neste diretório foi executado ainda no projeto de produção.

## Convenções

- Nome do arquivo: `YYYYMMDDHHMMSS_<fase>_<descricao>.sql`
- Todas as migrations devem ser idempotentes (`IF NOT EXISTS`, `IF EXISTS`, etc.) quando possível
- Toda migration DDL que toca tabela populada deve usar `CONCURRENTLY` ou padrão expand→migrate→contract
- Antes de aplicar qualquer uma: **snapshot do projeto** via Supabase Dashboard ou `pg_dump`

## Ordem de aplicação (Fase 1)

| # | Arquivo | Lock? | Como aplicar |
| --- | --- | --- | --- |
| 1 | `20260522120000_phase1_indexes_concurrent.sql` | nenhum | **NÃO** usar `apply_migration` (abre transação). Rodar cada `CREATE INDEX` separadamente via psql ou SQL Editor |
| 2 | `20260522120100_phase1_function_search_path.sql` | nenhum | Pode usar `apply_migration` ou SQL Editor |

## Checklist antes de aplicar

- [ ] Snapshot recente do projeto `vecnhoqtfsimasvglkqw` confirmado
- [ ] Janela de baixo tráfego identificada (opcional para Fase 1, recomendado para Fase 2+)
- [ ] Output do advisor de performance/security capturado como baseline
- [ ] Rollback plan documentado (para Fase 1: ver "Reversão" em cada arquivo)

## Fases futuras (não implementadas ainda)

Ver `docs/audit-2026-05-22.md` seção 5.

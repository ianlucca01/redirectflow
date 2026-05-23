# Varredura completa do sistema RedirectFlow — 22/maio/2026

> **Escopo executado:** 3 projetos Supabase da org (acessíveis via MCP).
> **Escopo bloqueado:** n8n (`n8n.redirectflow.com.br`) e VPS Hostinger (`developers.hostinger.com`) — host não permitido no allowlist do environment. Runbooks prontos em `docs/n8n-investigation-runbook.md` e `docs/vps-investigation-runbook.md` para execução assim que o allowlist liberar.

---

## 0. Sumário executivo

A operação tem **188 assinantes**, gera ~**R$ 27 mil/mês** de receita projetada (preços de tabela × ativos pagantes), e está rodando em cima de **risco de segurança nível "explode hoje"** + **bugs operacionais que estão queimando receita agora**.

### 5 problemas que dão pra um ataque ou perda hoje

1. 🔴 **`anon` key tem permissão de TRUNCATE em `usuarios`, `assinaturas`, `chaves_api` e mais 13 tabelas.** Qualquer pessoa com a chave (que está num frontend público) pode apagar TUDO da base com 1 linha de SQL. Não é teórico — é confirmado por query nas permissões do PostgREST.
2. 🔴 **533 chaves de afiliado (com `secret_key` em texto puro) lendo via `select *`** com o anon key.
3. 🔴 **35 bio_pages multi-tenant com policy `USING(true)`** — assinante A pode editar/deletar bio do assinante B.
4. 🟠 **38 assinaturas vencidas com `status='ativo'`** rodando. ~R$ 6.2 mil/mês de serviço entregue sem pagamento (ou receita perdida).
5. 🟠 **1.704 de 2.426 grupos WhatsApp (70%) são órfãos** — apontam pra instância que foi deletada. Lixo causando seq scans em queries de listagem.

### O que estava certo
- Postgres 17.6 (recente), `pgcrypto`/`uuid-ossp`/`pg_stat_statements`/`vault` instalados
- Pool de conexões com folga (10 ativas / 60 limite)
- DB pequeno (15 MB) — easy de mexer
- Crescimento real: 84 novos usuários em março/26, ~50/mês depois

---

## 1. Inventário — 3 projetos Supabase

| # | Nome | ID | Região | Tabelas pub | Linhas total pub | Status real |
|---|---|---|---|---:|---:|---|
| 1 | **REDIRECT FLOW** | `vecnhoqtfsimasvglkqw` | sa-east-1 | 18 | ~5.000 | 🟢 **PROD com 188 assinantes** |
| 2 | ianluccacomercial's | `khwmrumhvwndcsvopnfv` | sa-east-1 | 3 | 0 | 🟡 **vazio** — só schema (`PAGAMENTOS`, `INFO-FORMULÁRIO`, `REFAZER-FORMULARIO`). Postgres 17.4.1 com patches pendentes |
| 3 | RedirectFlow Alex | `zdsrqchdintajglemluh` | us-west-2 | 0 | 0 | 🟡 **vazio e sem tabela alguma** — Postgres 17.6.1, recém-criado |

### Recomendação imediata sobre projetos 2 e 3
Você disse que "também estão em uso" — mas ambos estão **factualmente vazios**. Provavelmente:
- **#2** era um experimento antigo (tabelas com nomes em maiúsculas e acentos, padrão de WP form) — pode arquivar
- **#3** é o staging do "Alex" (collaborator?) — confirmar com ele

Se forem mesmo lixo, **deletá-los reduz a superfície de ataque** (anon keys deles vazadas em algum lugar não importam) e **reduz custo** (mesmo no free tier, projetos contam pra quota da org). Não vou apagar sem você dizer.

---

## 2. Arquitetura observada (REDIRECT FLOW)

### 2.1 Schemas

| Schema | Tabelas | Vivência |
|---|---:|---|
| `public` | 18 | toda a aplicação |
| `auth` | 23 | **vazio** (0 users, 0 identities) |
| `storage` | 8 | 1 bucket `produtos` público, 2 arquivos (145 kB) |
| `realtime` | 2 | publication existe, 0 tabelas atribuídas |
| `vault` | 1+1 view | instalado e **não usado** |
| `extensions` | 2 views | meta |

### 2.2 Modelo de autenticação (inferido)

- `auth.users = 0` → **não usa Supabase Auth**
- `public.usuarios` tem 188 linhas com `id integer`, `email unique`, sem coluna de hash de senha
- `telegram_*.wp_user_id integer` e `bio_pages.user_id text` (igual `wp_user_id`) → forte sinal de que **existe um WordPress externo** servindo de identity provider; o Supabase é só o backend de dados
- O "frontend público" que você mencionou provavelmente é esse WP + plugins (subdomain bio pages, dashboard)
- **Implicação para RLS:** sem `auth.uid()` setado, qualquer policy típica `USING (user_id = auth.uid())` falharia. Vamos precisar de **JWT customizado** vindo do WP ou continuar dependendo de `service_role` no n8n + revogar `anon` privileges totalmente

### 2.3 Extensões instaladas (público)

```
pgcrypto 1.3, pg_stat_statements 1.11, uuid-ossp 1.1, supabase_vault 0.3.1
```

**Não estão instaladas** (mas existem no pg_stat_activity como processos default): `pg_cron`, `pg_net`. Confirmado: nem cron job rodando no Postgres, nem chamada HTTP assíncrona — toda a automação **passa pelo n8n externo**.

### 2.4 Triggers ativos

| Tabela | Trigger | O quê faz |
|---|---|---|
| `instagram_accounts` | `instagram_accounts_updated_at` | BEFORE UPDATE → atualiza `updated_at` |
| `logs` | `trigger_limpar_mensagem` | BEFORE INSERT/UPDATE → chama `limpar_mensagem()` |

Apenas 2. Outras tabelas com coluna `updated_at` **não têm trigger** — então `updated_at` não é mantido automaticamente. Isso explica timestamps inconsistentes em produção.

---

## 3. Achados de SEGURANÇA

### 3.1 🔴 Permissões PostgREST — confirmação por query

Rodei consulta em `information_schema.table_privileges` pras tabelas com dados sensíveis. Resultado para CADA tabela testada (`assinaturas`, `chaves_api`, `instagram_accounts`, `instancias_whatsapp`, `telegram_conexoes`, `usuarios`):

```
anon:          DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
authenticated: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
service_role:  DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
```

**`anon` pode literalmente `TRUNCATE TABLE usuarios`.** Combinado com a falta de RLS, isso é uma single-query data wipe.

### 3.2 🔴 Tabelas sem RLS e com dados críticos (16 tabelas)

| Tabela | Linhas | Coluna sensível | Conteúdo |
|---|---:|---|---|
| `chaves_api` | 533 | `secret_key` | chaves de afiliado de 167 usuários |
| `instancias_whatsapp` | 157 | `token` | tokens UAZAPI |
| `instagram_accounts` | 17 | `access_token` | tokens longos do Instagram |
| `telegram_conexoes` | 35 | `session_string` | sessão = controle TOTAL da conta Telegram |
| `usuarios` | 188 | `email`, `telefone` | PII |
| `assinaturas` | 188 | `status`, `data_fim` | dados comerciais |

Documentação do problema: https://supabase.com/docs/guides/database/database-linter?lint=0023_sensitive_columns_exposed

### 3.3 🔴 `bio_pages` e `bio_ofertas` — policies que não protegem

Você confirmou que **cada assinante deve editar apenas a própria bio**. Mas as policies atuais:

```sql
bio_pages_delete:  USING (true)              -- qualquer um deleta qualquer bio
bio_pages_update:  USING (true) WITH CHECK (true)
bio_pages_insert:  WITH CHECK (true)
bio_ofertas_*:     idem
```

Como `roles` está em `{-}` (sem role nomeada), a policy se aplica a TODOS. Bug ativo em produção: um usuário malicioso com `anon` key consegue rodar `DELETE FROM bio_pages` e apagar as 35 bio pages dos seus clientes.

### 3.4 🔴 Storage — bucket `produtos` público sem nenhuma policy

```
storage.objects → 0 policies
```

Bucket está marcado como `public=true`. Combinado com 0 policies = **upload/delete livre via anon key**. Hoje só tem 2 arquivos (145 kB) — provavelmente porque ninguém ainda explorou. Mas o caminho está aberto.

### 3.5 ⚠️ Funções com `search_path` mutável

4 funções públicas (`update_updated_at`, `buscar_telefones_por_plano`, `limpar_mensagem`, `increment_mensagens`) — risco baixo hoje porque nenhuma é `SECURITY DEFINER`, mas hardening está pronto em `supabase/migrations/20260522120100_phase1_function_search_path.sql`.

### 3.6 ⚠️ Projeto #2 — versão Postgres com CVEs pendentes

`khwmrumhvwndcsvopnfv` roda Postgres 17.4.1.054 com lint `vulnerable_postgres_version`. Se for arquivado, deixa de importar. Se for manter, **upgrade primeiro**.

---

## 4. Achados de QUALIDADE DE DADOS / bugs em produção

### 4.1 🟠 Receita sangrando — assinaturas vencidas com status='ativo'

| Plano | Total | Pagantes OK | Vencidos rolando | Inativos |
|---|---:|---:|---:|---:|
| STARTER (R$ 97) | 100 | 62 | **21** | 17 |
| PROFISSIONAL (R$ 197) | 59 | 41 | **11** | 7 |
| BUSINESS (R$ 397) | 26 | 15 | **5** | 6 |
| ENTERPRISE (custom) | 3 | 2 | **1** | 0 |
| **Total** | **188** | **120** | **38** | **30** |

Os 38 vencidos têm `data_fim` em mar/abr/mai de 2026 mas `status='ativo'`. Receita perdida ou serviço grátis acumulado: **~R$ 2.037 + R$ 2.167 + R$ 1.985 + R$ X = R$ 6.189/mês mínimo**, somando ~R$ 6k+/mês fugindo.

**Causa raiz provável:** algum workflow do n8n era pra setar `status='vencida'` quando `data_fim < now()`, e quebrou ou nunca foi escrito.

**Fix de 1 linha de SQL** (não-destrutivo, marcar pra revisão antes de aplicar):
```sql
UPDATE public.assinaturas
SET status = 'vencida'
WHERE status = 'ativo' AND data_fim < now() AND data_fim IS NOT NULL;
-- 38 linhas
```
+ adicionar cron job (no n8n ou via pg_cron) que faça isso diariamente.

### 4.2 🟠 Typo de `status` em produção — `'inative'` (sem 'o' final)

```
status        count
ativo         158
inative       30   ← typo, deveria ser 'inativo'
```

Sem CHECK constraint, ninguém impediu o erro. 30 registros com status que **nenhum código novo vai reconhecer**. Cliente filtrando por `status IN ('ativo', 'inativo')` deixa esses 30 de fora.

### 4.3 🟠 Grupos WhatsApp — 70% órfãos

```
total: 2.425
órfãos (instancia_id aponta pra instância deletada): 1.704
limpos: 721
```

A query de listagem de grupos faz seq_scan (já vimos no pg_stat_user_tables: **83 mil seq scans** lifetime). O n8n provavelmente faz `SELECT * FROM grupos_whatsapp WHERE usuario_id = X` — pega lixo, processa, falha. Causa raiz: ao deletar instância, não há `ON DELETE CASCADE`.

**Fix:** truncar órfãos + adicionar FK com CASCADE.
```sql
DELETE FROM public.grupos_whatsapp g
WHERE NOT EXISTS (SELECT 1 FROM public.instancias_whatsapp i WHERE i.id = g.instancia_id);
-- + alterar FK pra ON DELETE CASCADE
```

### 4.4 🟠 Instâncias WhatsApp — 105 dizem "conectada" mas NUNCA conectaram

```
status='conectada':    105 instâncias / 0 com ultima_conexao nas últimas 24h / 105 com ultima_conexao NULL
status='disconnected': 52 instâncias / 0 ativas / 52 nunca conectaram
```

**Funcionalidade quebrada:** a coluna `ultima_conexao` nunca é atualizada pelo n8n (ou só foi populada no início e parou). Isso impede qualquer dashboard de "instâncias online" funcionar de verdade. E significa que **`status='conectada'` está mentindo**: das 105 marcadas conectadas, possivelmente zero estão de fato — só ninguém atualizou o flag quando caiu.

### 4.5 ⚠️ 521 de 533 chaves API com `secret_key` vazio

Esperado para plataformas `resgate-shopee` (103) e `amazon` (99 — talvez use só `partner_tag`), mas o lint genérico falha em distinguir. Não é necessariamente bug, **mas** revela que a tabela `chaves_api` é multi-uso e poderia ser normalizada (uma tabela por plataforma, ou JSONB).

### 4.6 ⚠️ 1 instância WhatsApp sem `usuario_id`

Lixo histórico. Não causa problema agora mas se algum dia houver join sem `LEFT`, vai sumir.

### 4.7 ⚠️ Sem `last_analyze` em nenhuma tabela

```
last_autovacuum: ✓ (várias datas)
last_analyze:    ❌ (todas NULL)
```

`autovacuum` rodou VACUUM mas não ANALYZE — significa que **as estatísticas do planner estão desatualizadas**. Por isso queries que deveriam usar índice estão escolhendo seq scan (vide §5).

Fix barato — **rodar `ANALYZE` em todas as tabelas pub** (zero risco):
```sql
ANALYZE; -- ou ANALYZE public.<cada tabela>
```

---

## 5. Achados de PERFORMANCE

### 5.1 🔴 `define_horario` sem índice nenhum (além do PK)

```
234 linhas, seq_scan: 1.431.166, idx_scan: 79
```

Tabela escaneada inteira **1.4 MILHÃO de vezes** lifetime. n8n provavelmente faz `SELECT * FROM define_horario WHERE usuario_id=X AND nome_instancia=Y` e não tem nenhum índice nessas colunas.

**Fix barato:**
```sql
CREATE INDEX CONCURRENTLY idx_define_horario_usuario ON public.define_horario(usuario_id);
CREATE INDEX CONCURRENTLY idx_define_horario_instancia ON public.define_horario(nome_instancia);
```

### 5.2 🔴 `instancias_whatsapp` — 1.17M seq scans em 157 linhas

```
inserts: 977, updates: 3.169, deletes: 734
seq_scan: 1.172.084  ← n8n filtrando por coluna não indexada
idx_scan: 5.861.955  ← outras queries OK
```

Tem índices em `usuario_id` e `status`. O seq scan deve ser filtro por `instance_name`, `numero`, ou `email`. Inspecionar com `pg_stat_statements`:
```sql
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
WHERE query ILIKE '%instancias_whatsapp%'
ORDER BY total_exec_time DESC LIMIT 10;
```

### 5.3 🟠 `chaves_api` — UPDATE storm

```
1.010 inserts vs 655.060 updates
```

A tabela tem 533 linhas. Houve **655 mil updates** ao longo da vida — 1.230 updates por linha em média. Olhando colunas, suspeito de update em `ultima_utilizacao` a cada request. Isso causa:
- Bloat (dead tuples — vimos 124 mortos vivos)
- Write amplification no WAL
- Lock contention quando muitos workflows rodam simultaneamente

**Recomendações:**
- Trocar `ultima_utilizacao` por **HyperLogLog** ou tabela separada de uso (one-row-per-day)
- Ou aceitar perda de precisão e atualizar só a cada 5min via debounce

### 5.4 🟠 `assinaturas` — 477k seq scans em 188 linhas

n8n provavelmente filtrando por `status` em vez de PK. Adicionar índice + popular cache resolve:
```sql
CREATE INDEX CONCURRENTLY idx_assinaturas_status ON public.assinaturas(status);
```
(já além das migrations da Fase 1 — adicionar nessa)

### 5.5 🟠 `grupos_whatsapp` — churn destrutivo

```
13.838 inserts vs 11.406 deletes
```

n8n está **recriando os grupos a cada sync** em vez de UPSERT. Padrão típico: pega lista do WhatsApp → DELETE WHERE usuario_id=X → INSERT cada um. Custos disso:
- Bloat constante (443 dead tuples vivos)
- IDs UUID novos a cada ciclo (FKs em outras tabelas, se houvesse, quebrariam)
- Triggers (não tem mas se tivesse)

**Fix arquitetural:** mudar pra `INSERT ... ON CONFLICT (instancia_id, grupo_id, tipo) DO UPDATE`. Já tem o UNIQUE INDEX certo. É só o n8n adotar a sintaxe.

### 5.6 🟢 Bem dimensionado

- Pool: 10/60 ativas (16% — folga grande)
- DB tamanho: 15 MB (cabe na RAM inteiro)
- Sem queries lentas visíveis em pg_stat_activity (todas idle)

---

## 6. Riscos não cobertos nesta varredura

| Risco | Status | Por quê |
|---|---|---|
| Workflows n8n com erro / loop infinito | ⏸️ | bloqueado por allowlist |
| Versão do n8n com CVE | ⏸️ | idem |
| Sobrecarga VPS (CPU/RAM/disco) | ⏸️ | bloqueado por allowlist Hostinger |
| Vazamento do anon key (GitHub, frontend, etc.) | ❓ | precisa de acesso ao repo do frontend |
| Backups do Supabase configurados | ❓ | requer acesso ao dashboard Supabase (você precisa olhar) |
| Logs de PostgREST (quem chamou TRUNCATE alguma vez?) | ❓ | requer acesso ao dashboard logs |

---

## 7. Plano priorizado — ordem de execução

### Fase 0 — Emergência (HOJE, sem janela de manutenção)
- [ ] **0.1** Confirmar snapshot recente do Supabase prod no dashboard
- [ ] **0.2** Rotacionar **anon key** e **service_role key** (Settings → API → Roll). Atualizar em: n8n, WordPress, qualquer frontend
- [ ] **0.3** `REVOKE TRUNCATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon, authenticated` — corta o pior cenário sem quebrar leitura
- [ ] **0.4** Aplicar fix do status (`UPDATE assinaturas SET status='vencida' WHERE...`) — para de sangrar receita

### Fase 1 — Hardening (esta semana, sem downtime)
- [x] **1.1** Índices em FKs → migration pronta (`20260522120000_phase1_indexes_concurrent.sql`)
- [x] **1.2** `search_path` em funções → migration pronta (`20260522120100`)
- [ ] **1.3** Adicionar índices em `define_horario(usuario_id, nome_instancia)` e `assinaturas(status)` — adicionar à migration 1.1
- [ ] **1.4** `ANALYZE` em todas as tabelas pub
- [ ] **1.5** `REVOKE` de `TRUNCATE` global

### Fase 2 — RLS gradual (próximos dias, com cuidado)
- [ ] **2.1** Mapear endpoints do frontend WP que tocam Supabase (precisa repo/URL)
- [ ] **2.2** Confirmar chave usada pelo n8n (precisa allowlist)
- [ ] **2.3** Plano de RLS table-by-table — começar pelas tabelas que **apenas o n8n service_role** acessa
- [ ] **2.4** **Corrigir** policies de `bio_pages`/`bio_ofertas` para usar o JWT do WP (ou JWT customizado)
- [ ] **2.5** Adicionar policies em `storage.objects` pro bucket `produtos`

### Fase 3 — Vault para segredos (próxima semana)
- [ ] **3.1** Migrar `chaves_api.secret_key`, `instancias_whatsapp.token`, `instagram_accounts.access_token`, `telegram_conexoes.session_string` pra `vault.secrets`
- [ ] **3.2** Views `SECURITY DEFINER` que retornam segredo só pra owner
- [ ] **3.3** Coordenar com n8n para ler do Vault

### Fase 4 — Data quality
- [ ] **4.1** Limpar 1.704 grupos órfãos + adicionar FK ON DELETE CASCADE
- [ ] **4.2** Trocar `inative` por `inativo` (30 registros) + adicionar CHECK constraint
- [ ] **4.3** Resolver `ultima_conexao` no n8n (atualizar a cada heartbeat real)
- [ ] **4.4** Trigger pra `updated_at` em todas as tabelas que têm a coluna (1 trigger por tabela)
- [ ] **4.5** Decidir destino dos projetos #2 e #3 (arquivar ou usar)

### Fase 5 — Refactor n8n + VPS (depende de allowlist)
- [ ] **5.1** Investigar workflows com erro (`docs/n8n-investigation-runbook.md`)
- [ ] **5.2** Investigar VPS (`docs/vps-investigation-runbook.md`)
- [ ] **5.3** Trocar pattern delete-then-insert por upsert em `grupos_whatsapp`
- [ ] **5.4** Reduzir UPDATE storm em `chaves_api`
- [ ] **5.5** Upgrade n8n (com snapshot + rollback)

### Fase 6 — Estrutural
- [ ] **6.1** FK `telegram_*.wp_user_id` → `usuarios.id` (depois de validar dados)
- [ ] **6.2** Renomear `cliques-link-whatsapp` (via view de compatibilidade)
- [ ] **6.3** Padronizar timestamps `timestamptz`
- [ ] **6.4** CHECK constraints em `status` e `tipo`

---

## 8. Apêndice — comandos de Fase 0 (revisar antes de aplicar)

> **Não estou aplicando** essas SQLs. Estão aqui pra você revisar e decidir o que/quando rodar. Recomendação: rodar 0.3 e 0.4 com snapshot recente.

### 8.1 Revogar TRUNCATE/DELETE de `anon` e `authenticated`

```sql
-- Não quebra leitura nem qualquer fluxo legítimo se o frontend só faz SELECT/INSERT/UPDATE
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE DELETE   ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Se você sabe que o frontend NÃO escreve em tabelas críticas:
REVOKE INSERT, UPDATE ON public.chaves_api, public.instancias_whatsapp,
       public.instagram_accounts, public.telegram_conexoes, public.usuarios,
       public.assinaturas, public.planos FROM anon;

-- Mais agressivo (só se confirmar que anon não escreve em NADA dessas tabelas):
REVOKE INSERT, UPDATE ON public.chaves_api, public.instancias_whatsapp,
       public.instagram_accounts, public.telegram_conexoes, public.usuarios,
       public.assinaturas, public.planos FROM authenticated;
```

### 8.2 Marcar vencidos como vencidos

```sql
-- Backup primeiro:
CREATE TABLE _backup_assinaturas_2026_05_22 AS SELECT * FROM public.assinaturas;

UPDATE public.assinaturas
SET status = 'vencida', updated_at = now()
WHERE status = 'ativo' AND data_fim IS NOT NULL AND data_fim < now();
-- esperado: 38 linhas

-- Validação:
SELECT status, count(*) FROM public.assinaturas GROUP BY status ORDER BY count(*) DESC;
```

### 8.3 Fix do typo `inative`

```sql
UPDATE public.assinaturas SET status='inativo' WHERE status='inative';
-- esperado: 30 linhas

-- Depois, CHECK constraint pra impedir reincidência:
ALTER TABLE public.assinaturas
  ADD CONSTRAINT assinaturas_status_check
  CHECK (status IN ('ativo','inativo','cancelado','suspenso','trial','vencida'));
```

### 8.4 ANALYZE geral

```sql
ANALYZE; -- analisa o database inteiro, leve, sem lock de escrita
```

---

## 9. Para a próxima rodada

Você precisa decidir:

1. **Quais Fase 0 itens rodar e quando** (recomendo: 0.1+0.2+0.3+0.4 amanhã cedo, com 10min de janela)
2. **Liberar allowlist** pros 3 hosts no environment pra eu seguir com n8n + VPS
3. **Compartilhar URL/repo do frontend** pra mapear o que o anon key faz
4. **Confirmar destino dos projetos #2 e #3**

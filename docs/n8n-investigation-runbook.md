# Runbook — Investigação n8n RedirectFlow

> **Status:** preparado em 2026-05-22, **NÃO executado** ainda — espera allowlist `n8n.redirectflow.com.br`.
> **Objetivo:** identificar erros, gargalos e oportunidades de otimização nos workflows do n8n.
> **Como usar:** quando o allowlist estiver liberado, executar os blocos em ordem. Cada bloco devolve um JSON; cada `## Decisão` indica o que olhar nele.

## 0. Pré-requisitos

```bash
# Token vive em /tmp/.n8nkey (chmod 600). Caso a sessão tenha sido recriada,
# o usuário precisa mandar o JWT novo (após rotação).
test -s /tmp/.n8nkey || { echo "Token n8n ausente — pedir ao usuário"; exit 1; }
chmod 600 /tmp/.n8nkey

# Helper função (re-source a cada Bash call no sandbox):
n8n() { curl -sS --max-time 30 -H "X-N8N-API-KEY: $(cat /tmp/.n8nkey)" "https://n8n.redirectflow.com.br$1"; }
```

---

## 1. Conectividade + versão

```bash
# Sem auth — só pra confirmar que o host responde
curl -sSi --max-time 10 https://n8n.redirectflow.com.br/healthz | head -5

# Versão e settings (endpoint /rest é interno; pode exigir cookie. Tentar primeiro)
n8n /rest/settings 2>/dev/null | jq '{version: .data.versionCli, db: .data.databaseType, license: .data.license.planName, executions_mode: .data.executions.mode, pushBackend: .data.pushBackend, timezone: .data.timezone, pruning: .data.pruning}'

# Fallback: pegar versão do header `x-n8n-version` na home
curl -sSI https://n8n.redirectflow.com.br/ | grep -i n8n-version
```

### Decisão
- Se `version` < 1.50: **upgrade prioritário** (há ganhos de performance significativos no scheduler 1.50+)
- Se `executions_mode = "regular"` (em vez de `"queue"`): **gargalo arquitetural** — execuções rodam no mesmo processo do UI, qualquer pico bloqueia todos os webhooks
- Se `db = "sqlite"`: **upgrade urgente pra postgres** (sqlite trava acima de ~5 req/s simultâneas)

---

## 2. Workflows — inventário

```bash
n8n "/api/v1/workflows?limit=250" > /tmp/wf.json
echo "bytes: $(wc -c < /tmp/wf.json), workflows: $(jq '.data | length' /tmp/wf.json)"

# Resumo: ativos, inativos, top por número de nodes
jq '{
  total: (.data | length),
  active_count: ([.data[] | select(.active)] | length),
  inactive_count: ([.data[] | select(.active|not)] | length),
  total_nodes: ([.data[].nodes | length] | add),
  top10_largest: [.data[] | {name, id, active, nodeCount: (.nodes|length), tags: [.tags[]?.name]}] | sort_by(.nodeCount) | reverse | .[0:10]
}' /tmp/wf.json
```

### Decisão
- Workflows com >50 nodes: **candidatos a refactor** (quebrar em sub-workflows via Execute Workflow node)
- Workflows inativos: confirmar com usuário se podem ser arquivados (reduz overhead de carregamento)

---

## 3. Triggers — distribuição

```bash
jq '[.data[] | .nodes[] | select(.type | test("Trigger|Webhook|Cron|Schedule|Poll")) | {workflow_id: input.id, type, polling: (.parameters.pollTimes // null)}]' /tmp/wf.json 2>/dev/null

# Alternativa mais simples (sem input):
jq '[.data[] | {wf: .name, triggers: [.nodes[] | select(.type | test("Trigger|Webhook|Schedule")) | .type]}] | group_by(.triggers[0]?) | map({trigger: .[0].triggers[0]?, count: length})' /tmp/wf.json
```

### Decisão
- Muitos `scheduleTrigger` com `everyMinute`: **revisar** — substituir por webhook quando possível
- `n8n-nodes-base.start` (manual): workflow só roda quando alguém clica — provável dev/test esquecido ativo

---

## 4. Execuções — visão geral (últimas 250)

```bash
n8n "/api/v1/executions?limit=250&includeData=false" > /tmp/ex.json

jq '{
  total: (.data | length),
  by_status: ([.data[].status // (if .finished then "success" else "running" end)] | group_by(.) | map({status: .[0], count: length})),
  by_mode: ([.data[].mode] | group_by(.) | map({mode: .[0], count: length})),
  oldest: ([.data[].startedAt] | min),
  newest: ([.data[].startedAt] | max),
  running_now: ([.data[] | select(.status=="running" or (.finished==false and .stoppedAt==null))] | length),
  avg_duration_ms: ([.data[] | select(.stoppedAt and .startedAt) | (((.stoppedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - (.startedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) * 1000)] | add / length)
}' /tmp/ex.json
```

### Decisão
- `running_now > 5` por mais de 30s: provável **deadlock** ou worker travado
- `avg_duration_ms > 30000`: workflow médio gastando >30s — investigar nodes lentos (HTTP timeout, query Postgres sem index, loop sem batch)

---

## 5. Erros — agrupamento por workflow

```bash
n8n "/api/v1/executions?limit=250&status=error&includeData=false" > /tmp/ex_err.json

# Top workflows por número de erros recentes
jq '{
  total_errors_window: (.data | length),
  by_workflow: ([.data[] | {wfId: .workflowId, wfName: .workflowData.name}] | group_by(.wfId) | map({wfId: .[0].wfId, wfName: .[0].wfName, errors: length}) | sort_by(.errors) | reverse | .[0:10]),
  error_rate_per_hour: ([.data[].startedAt] | group_by(. | sub("T(?<h>[0-9]+):.*"; "T\(.h)")) | map({hour: .[0] | sub("T(?<h>[0-9]+):.*"; "T\(.h)"), count: length}))
}' /tmp/ex_err.json
```

### Decisão
- Top-3 workflows com >20 erros nos últimos 250 execuções: **prioridade 1** — abrir cada um pra ver causa
- Se erro_rate concentrado em 1 hora específica: **cron storm** ou pico de tráfego (correlacionar com VPS metrics)

---

## 6. Deep-dive nos top-3 workflows com erro

```bash
# Pegar os 3 IDs do passo anterior, e pra cada um:
WFID=<id>

# Detalhe do workflow
n8n "/api/v1/workflows/$WFID" | jq '{name, active, nodeCount: (.nodes|length), settings, staticData_size: (.staticData | tostring | length), error_workflow: .settings.errorWorkflow, timezone: .settings.timezone, executionTimeout: .settings.executionTimeout, saveDataErrorExecution: .settings.saveDataErrorExecution}'

# Últimas 5 execuções com erro DESSE workflow (com data) — pra ver o nó que falhou
n8n "/api/v1/executions?limit=5&status=error&workflowId=$WFID&includeData=true" > /tmp/ex_wf.json
jq '[.data[] | {id, startedAt, error_node: (.data.resultData.lastNodeExecuted), error_message: (.data.resultData.error.message // .data.resultData.error.description // null), error_stack: (.data.resultData.error.stack[0:200] // null)}]' /tmp/ex_wf.json
```

### Decisão
- `error_node` repetido nas 5 execuções: nó específico travando → corrigir nesse nó
- `error_message` contendo "timeout" ou "ETIMEDOUT": problema de rede / API externa lenta → adicionar retry node ou aumentar timeout
- `error_message` contendo "duplicate key" ou "violates unique constraint": **dados duplicados ou falta de idempotência** → adicionar deduplication
- `settings.errorWorkflow` nulo: **workflow não tem error handler** — recomendar criar um workflow de erro centralizado
- `executionTimeout` nulo: **sem timeout** — workflow pode ficar running pra sempre

---

## 7. Heurísticas de otimização (varredura geral)

```bash
# Workflows sem error workflow
jq '[.data[] | select(.active and (.settings.errorWorkflow == null)) | {name, id}]' /tmp/wf.json

# Workflows sem timeout
jq '[.data[] | select(.active and ((.settings.executionTimeout // 0) == 0)) | {name, id}]' /tmp/wf.json

# Workflows com `Wait` node (atenção: bloqueia worker em modo regular)
jq '[.data[] | select(.active) | select([.nodes[] | select(.type=="n8n-nodes-base.wait")] | length > 0) | {name, id, wait_count: ([.nodes[] | select(.type=="n8n-nodes-base.wait")] | length)}]' /tmp/wf.json

# Nodes deprecated (typeVersion antiga vs latest)
jq '[.data[] | .nodes[] | select(.typeVersion < 2) | {type, typeVersion}] | group_by(.type) | map({type: .[0].type, count: length})' /tmp/wf.json

# Credenciais hardcoded (parâmetros que cheirem a token/key/password)
jq '[.data[] | {wf: .name, suspicious: [.nodes[] | .parameters | tostring | scan("(api[_-]?key|token|password|secret)\\\"?:\\s*\\\"[^\\\"]{8,}")] | length}] | map(select(.suspicious > 0))' /tmp/wf.json
```

### Decisão
- Cada item achado vira uma linha no relatório de otimização (`docs/n8n-findings-YYYY-MM-DD.md`)

---

## 8. Credenciais — schema only (Public API não expõe valores)

```bash
n8n "/api/v1/credentials" 2>&1 | head -50  # provavelmente retorna 405 — só schema
# Listar tipos de credenciais usadas:
jq '[.data[] | .nodes[] | .credentials // {}] | [.[] | keys[]?] | group_by(.) | map({type: .[0], count: length}) | sort_by(.count) | reverse' /tmp/wf.json
```

### Decisão
- Verificar se há credenciais duplicadas (mesma plataforma, 5 entradas) — consolidar
- Verificar se há credenciais com nome do tipo "test" / "old" — limpar

---

## 9. Tags / organização

```bash
jq '[.data[].tags[]?.name] | group_by(.) | map({tag: .[0], count: length}) | sort_by(.count) | reverse' /tmp/wf.json
```

### Decisão
- Se >50 workflows sem nenhuma tag: recomendar taxonomia (`prod`, `dev`, `customer-*`, `whatsapp`, `telegram`, etc.)

---

## 10. Output final — `docs/n8n-findings-YYYY-MM-DD.md`

Estrutura:
```
# Achados n8n — <data>

## Versão / arquitetura
- Versão atual: X.Y.Z (latest: A.B.C)
- DB: postgres/sqlite
- Mode: regular/queue
- ⚠️ Necessita upgrade? sim/não — justificativa

## Top-5 workflows problemáticos
1. [nome] — N erros / [erro mais comum] — fix proposto
...

## Otimizações detectadas
- N workflows sem error workflow → propor template
- N workflows sem timeout → setar default 60s
- N nodes deprecated → migrar typeVersion
- N credenciais duplicadas

## Plano priorizado
| # | Ação | Impacto | Risco | Esforço |
|---|------|---------|-------|---------|
| 1 | Upgrade n8n X→Y | alto | médio | 30min |
| 2 | Setar errorWorkflow padrão | alto | baixo | 20min |
| 3 | Refactor wf "X" | médio | baixo | 1h |
```

---

## 11. Limpeza (final do trabalho)

```bash
shred -u /tmp/.n8nkey 2>/dev/null || rm -f /tmp/.n8nkey
rm -f /tmp/wf.json /tmp/ex*.json
```

E lembrar o usuário de **rotacionar o JWT** no painel do n8n.

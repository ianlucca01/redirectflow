# Runbook — Investigação VPS Hostinger (RedirectFlow)

> **Status:** preparado em 2026-05-22, **NÃO executado** ainda — espera allowlist `developers.hostinger.com`.
> **Objetivo:** identificar sobrecarga, gargalos de recursos, problemas de container e preparar plano de upgrade do n8n.
> **Como usar:** quando o allowlist estiver liberado, executar os blocos em ordem via Hostinger MCP.

## 0. Pré-requisitos

- `API_TOKEN` (Hostinger) já configurado no environment desta sessão como secret
- Hostinger MCP server conectado (`mcp__hostinger-mcp__*` tools disponíveis)
- Confirmar via ToolSearch antes de cada batch

```
ToolSearch("select:mcp__hostinger-mcp__VPS_getVirtualMachinesV1,...")
```

---

## 1. Inventário — quais VMs existem

```
mcp__hostinger-mcp__VPS_getVirtualMachinesV1()
```

### Decisão
- Identificar VM do n8n (esperado: hostname/IP que aponta pra `n8n.redirectflow.com.br`)
- Anotar `vmId`, `subscriptionId`, plano, datacenter, IP
- Salvar em variável mental: `N8N_VM_ID=<id>`

Se houver múltiplas VMs: anotar todas e perguntar ao usuário qual hospeda o n8n.

---

## 2. Detalhes da VM (specs)

```
mcp__hostinger-mcp__VPS_getVirtualMachineDetailsV1(virtualMachineId: N8N_VM_ID)
```

### Decisão
- Anotar: vCPUs, RAM total, disco total, sistema operacional, template (Ubuntu 22? Debian 12? CyberPanel?)
- Se RAM < 4GB e n8n está com >100 workflows: **upgrade de plano** é candidato
- Se disco usado > 80%: investigar o que está enchendo (logs, executions histórico, docker images antigas)

---

## 3. Métricas — últimas 24h

```
mcp__hostinger-mcp__VPS_getMetricsV1(
  virtualMachineId: N8N_VM_ID,
  dateFrom: "<ISO 24h atrás>",
  dateTo: "<ISO agora>"
)
```

### Decisão
- **CPU >80% sustentado por >5min**: gargalo de CPU → motivos comuns: workflow infinito, polling agressivo, n8n em modo regular processando muitas execuções
- **RAM >90%**: gargalo de memória → motivos comuns: execuções com payload grande mantidas em saveDataSuccess, vazamento de memória em node custom, postgres sem `shared_buffers` ajustado
- **Disco I/O alto**: postgres sem index, logs verbosos, swap excessivo
- **Network out alto**: webhook storm ou exfiltração de dados (suspeito)
- Identificar **picos** e correlacionar com horários dos erros n8n (passo 5 do runbook n8n)

---

## 4. Containers Docker — o que está rodando

```
mcp__hostinger-mcp__VPS_getProjectListV1(virtualMachineId: N8N_VM_ID)
```

Lista projetos Docker Compose. Provável: `n8n` (ou `redirectflow`).

```
mcp__hostinger-mcp__VPS_getProjectContainersV1(virtualMachineId: N8N_VM_ID, projectName: "<nome>")
```

### Decisão
- Esperado encontrar: `n8n`, `postgres` (n8n DB), talvez `redis` (queue mode), `traefik`/`nginx`/`caddy` (reverse proxy)
- Para cada container: anotar `image`, `status`, `restartPolicy`, `cpu_usage`, `memory_usage`
- Containers em `restarting` repetido: **crashloop** → puxar logs imediatamente
- Containers sem `restart: unless-stopped`: **risco** de não voltarem após reboot

---

## 5. docker-compose.yml + .env do projeto

```
mcp__hostinger-mcp__VPS_getProjectContentsV1(virtualMachineId: N8N_VM_ID, projectName: "<nome>")
```

### Decisão
- Ler o compose pra entender topologia exata
- Procurar:
  - **n8n image tag**: se `latest` → ruim (não reproduzível); se `n8nio/n8n:1.X.Y` → bom
  - **DB_TYPE**: deve ser `postgresdb` (não sqlite)
  - **EXECUTIONS_MODE**: `queue` (com redis) é melhor que `regular` pra alto volume
  - **EXECUTIONS_DATA_PRUNE**: deve ser `true` com `EXECUTIONS_DATA_MAX_AGE=336` (14 dias)
  - **N8N_METRICS=true**: pra expor Prometheus metrics
  - **WEBHOOK_URL**: deve ser a URL pública (`https://n8n.redirectflow.com.br`)
  - **N8N_RUNNERS_ENABLED=true** (a partir de 1.69, força task runners — melhor isolation)
- Procurar volumes: `/home/node/.n8n` deve estar em volume nomeado (não bind sem backup)

---

## 6. Logs por container (últimas N linhas)

```
mcp__hostinger-mcp__VPS_getProjectLogsV1(virtualMachineId: N8N_VM_ID, projectName: "<nome>", containerName: "n8n", tail: 500)
mcp__hostinger-mcp__VPS_getProjectLogsV1(virtualMachineId: N8N_VM_ID, projectName: "<nome>", containerName: "postgres", tail: 200)
```

### Decisão (n8n logs)
- `ECONNREFUSED postgres`: DB caiu — investigar
- `Worker not picking up jobs`: redis / queue config issue
- Workflows ID repetidos com erro: confirma o que vi na API
- `Out of memory` / `JavaScript heap out of memory`: aumentar `NODE_OPTIONS=--max-old-space-size=4096` ou subir RAM

### Decisão (postgres logs)
- `checkpoints occurring too frequently`: aumentar `max_wal_size`
- `slow query > 1000ms`: investigar query → faltam índices
- `connection refused`: pool exausto → aumentar `max_connections` ou usar pooler

---

## 7. Histórico de ações (restart, OOM, etc.)

```
mcp__hostinger-mcp__VPS_getActionsV1(virtualMachineId: N8N_VM_ID)
```

### Decisão
- Múltiplos `restart` automáticos: VM está sendo derrubada (OOM?) → upgrade RAM ou otimizar
- Snapshots/backups recentes: confirmar pré-requisito pro upgrade

---

## 8. Backups e snapshots

```
mcp__hostinger-mcp__VPS_getBackupsV1(virtualMachineId: N8N_VM_ID)
mcp__hostinger-mcp__VPS_getSnapshotV1(virtualMachineId: N8N_VM_ID)  # se houver
```

### Decisão
- **Antes de QUALQUER upgrade**: confirmar backup das últimas 24h
- Se backup automático estiver desligado: ligar agora
- Se não há snapshot recente: criar via `VPS_createSnapshotV1` antes do upgrade

---

## 9. Firewall e segurança

```
mcp__hostinger-mcp__VPS_getFirewallListV1()
mcp__hostinger-mcp__VPS_getFirewallDetailsV1(firewallId: <id>)
mcp__hostinger-mcp__VPS_getScanMetricsV1(virtualMachineId: N8N_VM_ID)  # se Monarx instalado
```

### Decisão
- Portas abertas: deve ser só 22 (SSH com chave), 80, 443. Se 5432 (postgres) está aberto → **fechar imediatamente**
- Monarx scan: ver se há detecções recentes de malware/intrusão

---

## 10. Plano de upgrade n8n (executar APENAS após investigação completa)

### 10.1 Pré-flight checklist
- [ ] Snapshot manual criado e ID anotado
- [ ] Backup do volume `/home/node/.n8n` (especialmente `database.sqlite` ou backup do postgres)
- [ ] Export de todos os workflows ativos: `n8n export:workflow --all --backup --output=/tmp/wf-backup-YYYYMMDD/`
- [ ] Export de credenciais: `n8n export:credentials --all --backup --output=/tmp/cred-backup-YYYYMMDD/`
- [ ] Versão atual anotada (do passo 5)
- [ ] Versão alvo escolhida (latest do Docker Hub vs stable LTS atual)
- [ ] Changelog lido entre versões — breaking changes anotados
- [ ] Janela de manutenção combinada com usuário

### 10.2 Upgrade sequence
> **Estratégia:** stop → swap image → start. Downtime esperado: 30-90s.
> Não dá pra fazer rolling upgrade de n8n single-instance sem queue mode + 2 workers.

```bash
# Via Hostinger Post-Install Scripts ou SSH (depende da capacidade):
cd /opt/n8n  # ou onde está o compose
docker compose pull n8n
docker compose down n8n
docker compose up -d n8n
docker compose logs -f n8n  # esperar ver "Editor is now accessible"
```

### 10.3 Smoke test pós-upgrade
- [ ] `curl https://n8n.redirectflow.com.br/healthz` → 200
- [ ] UI abre sem erro
- [ ] Listar workflows ativos via Public API → mesma contagem
- [ ] Disparar 1 execução manual de um workflow simples → success
- [ ] Verificar logs por 5 min → nenhum ERROR

### 10.4 Rollback (se algo quebrar)
```bash
# Edit docker-compose.yml: trocar image tag pra versão anterior
docker compose down n8n
docker compose up -d n8n
# Se DB schema migrou e é incompatível: restore snapshot/backup
```

---

## 11. Otimizações pós-investigação (lista candidata)

Dependendo dos achados:

- **Migrar de regular → queue mode** (requer redis): aumenta throughput
- **Habilitar EXECUTIONS_DATA_PRUNE=true**: limpa histórico antigo, reduz DB
- **N8N_RUNNERS_ENABLED=true**: isola execuções em sub-processos
- **Postgres tuning**: `shared_buffers=25%RAM`, `effective_cache_size=75%RAM`, `work_mem=64MB`
- **Reverse proxy timeout aumentar**: nginx/traefik default 60s pode cortar webhooks longos
- **Log rotation**: docker-compose com `logging.options.max-size=10m, max-file=3`
- **Adicionar healthcheck no compose**: pra restart automático funcionar
- **Habilitar N8N_METRICS=true** + scraper Prometheus: visibilidade contínua

---

## 12. Output final — `docs/vps-findings-YYYY-MM-DD.md`

```
# VPS RedirectFlow — achados <data>

## Specs atuais
| Item | Valor |
|---|---|
| Plano | KVM X |
| vCPU | N |
| RAM | XGB |
| Disco | XGB usado de YGB |
| OS | Ubuntu X.Y |

## Sobrecarga identificada
- CPU médio 24h: X%
- Pico: X% às HH:MM (correlacionado com workflow Y)
- RAM uso médio: X%
- Disco I/O médio: X MB/s

## Containers
| Container | Image | Status | CPU | RAM | Restarts |
|---|---|---|---|---|---|
| n8n | n8nio/n8n:1.X | running | X% | YMB | N |
| postgres | postgres:15 | running | X% | YMB | N |

## Problemas críticos
1. ...

## Recomendações priorizadas
| # | Ação | Impacto | Esforço | Janela |
|---|---|---|---|---|
| 1 | ... | ... | ... | ... |
```

# CHANGELOG — Refator do workflow GLOBAL

Cada fase é um patch isolado, reversível e auditável. Aplicar em ordem.
Cada fase deve rodar em produção por **pelo menos 24h** antes da próxima.

---

## ✅ Fase 1 — Remoção de código morto (APLICÁVEL)

**Risco:** Zero · **Comportamento muda?** Não · **Reversível?** Sim

Remove 8 nós marcados com `disabled: true` que ocupam espaço no canvas mas
nunca executam. Limpa também as conexões órfãs apontando para eles.

### Nós removidos

| Nó | Motivo histórico |
|----|---------------|
| `pega imagem` | Branch OG image antiga, substituída por `puppeter :3050` |
| `API DESENCURTAR LINK` | Desencurtador RapidAPI antigo, substituído por `:3052` |
| `Get a row10` | Tentativa de log antifraude, desabilitada |
| `If12` | Mesma cadeia acima |
| `Create a row` | Mesma cadeia acima |
| `Get a row11` | Mesma cadeia acima |
| `If13` | Mesma cadeia acima |
| `Create a row1` | Mesma cadeia acima |

### Como aplicar

```bash
# 1. No n8n: Export do workflow GLOBAL → salva como global.original.json
# 2. Roda o script:
node workflows/refactor-global.mjs \
     workflows/global.original.json \
     workflows/global.fase1.json
# 3. Importa global.fase1.json num workflow DE TESTE no n8n
# 4. Compara canvas com o original — nós executáveis devem ser idênticos
# 5. Se OK, ativa em produção (mantendo backup do original)
```

### Como reverter

Reimportar o `global.original.json`.

---

## 🟡 Fase 2 — Deduplicação simples (NÃO APLICADA AINDA)

**Risco:** Baixo · **Comportamento muda?** Não · **Reversível?** Sim

Consolida nós que rodam exatamente a mesma lógica em pontos diferentes do fluxo.

### Planejado

| Hoje | Depois |
|------|--------|
| 6× `DESENCURTADOR_DE_LINK*` (mesma chamada a `:3052`) | 1 nó reusável |
| 4× código "identifica plataforma" (regex idêntica) | 1 nó Code |
| `Code in JavaScript17` ≡ `Code in JavaScript18` (idênticos) | 1 nó |
| 5× `baixa imagem*` + 5× `UPLOUD VPS*` | Subworkflow `baixar_e_subir_imagem` |

### Por que NÃO está aplicada

Cada consolidação muda a topologia do grafo. Em n8n, a posição do nó altera
em qual contexto o `$node["X"].json` é resolvido. Antes de aplicar, é preciso:

1. Mapear todos os pontos do workflow que referenciam cada nó pelo nome
2. Atualizar essas referências quando o nome consolidado mudar
3. Testar em staging com payload real (mensagem-imagem, mensagem-texto,
   mensagem-imagem-com-texto) para os 3 marketplaces

Estimativa: 2h de trabalho + 1 dia de observação.

---

## 🟡 Fase 3 — Eliminar AI Agents da Shopee (NÃO APLICADA AINDA)

**Risco:** Baixo-Médio · **Comportamento muda?** Sim (positivo) · **Reversível?** Sim

`AI Agent1` e `AI Agent2` usam LLM como fallback do regex de extração
`shop_id`/`item_id`. O regex em `Code in JavaScript4` e `Code in JavaScript11`
cobre todos os formatos conhecidos. O LLM dispara **toda execução Shopee**
mesmo quando o regex acerta.

### Planejado

- Remover `AI Agent1`, `OpenRouter Chat Model1`, `Code in JavaScript`
- Remover `AI Agent2`, `OpenRouter Chat Model2`, `Code in JavaScript13`
- Se regex falhar em algum link real, adicionar o padrão ao regex (não LLM)

### Ganho

Economia direta em OpenRouter (1 chamada LLM por execução Shopee evitada)
+ ~6 nós a menos no canvas.

### Por que NÃO está aplicada

Risco residual: se algum cliente recebeu link Shopee em formato exótico que
o regex não cobre e o LLM resolvia, vai falhar. Precisa amostragem dos
logs de 7-14 dias pra ter certeza.

---

## 🟡 Fase 4 — Code `valida_publicacao` (NÃO APLICADA AINDA)

**Risco:** Médio · **Comportamento muda?** Não · **Reversível?** Sim

Substitui a árvore de 12 nós If/Switch (Switch4 → If17/If18/If19 →
If23/If10/If9, espelhada em Switch5 → If20/If21/If22 → If26/If25/If24)
por **1 Code node** que retorna `{ok, motivo}`.

A árvore atual faz: "tem chave da plataforma X cadastrada E ela está na lista
de marketplaces ativos?" — 12 nós pra responder isso.

### Por que NÃO está aplicada

Precisa testar matriz completa: 3 plataformas × com/sem chave cadastrada ×
com/sem na allowlist de marketplaces. 12 combinações, regressão completa.

---

## 🔴 Fase 5 — Subworkflow `disparar_para_grupos` (NÃO APLICADA AINDA)

**Risco:** Alto · **Comportamento muda?** Não (se feito certo) · **Reversível?** Sim

O padrão `Get a row (grupos disparar) → Loop → Wait 8s → HTTP /send/*`
aparece 7× no workflow. Cada plataforma + cada variação (com/sem imagem)
tem sua própria cópia.

### Planejado

1 subworkflow recebe `{usuario_id, instancia_id, token, payload}` e dispara
para todos os grupos `tipo=disparar` do assinante.

### Por que NÃO está aplicada

Este é o **coração do negócio** — onde as mensagens efetivamente saem para
clientes finais. Qualquer regressão = mensagens perdidas = comissões perdidas.

Exige:
- Subworkflow novo + teste isolado em conta de dev
- Janela de baixo tráfego pra migrar
- Rollback plan documentado
- Monitoramento ativo das primeiras 24h

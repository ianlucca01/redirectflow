# workflows/

Refator do workflow n8n GLOBAL do RedirectFlow.

## Por que existe

O workflow GLOBAL tem 193 nós, vários anos de patches em cima de patches, e
duplicações que dificultam manutenção. Este diretório guarda os scripts e a
documentação do refator incremental que reduz o workflow a algo manutenível
sem mudar comportamento de produção.

## Estratégia

Mudanças em **fases isoladas**, cada uma reversível e auditável. Nada é
aplicado direto em produção — sempre via export → script → workflow de
teste → comparação → promoção.

Detalhe de cada fase está em [`CHANGELOG.md`](./CHANGELOG.md).

## O que já roda agora

Só a **Fase 1** (remoção de código morto) está implementada em
[`refactor-global.mjs`](./refactor-global.mjs). É a única mudança que
posso garantir sem testar em produção, porque remove nós que já estão
desabilitados.

## Como usar (Fase 1)

```bash
# 1. No n8n: abre o workflow GLOBAL → menu ⋮ → Download
#    Salva como workflows/global.original.json (NÃO commitar — tem credenciais)

# 2. Roda o script
node workflows/refactor-global.mjs \
     workflows/global.original.json \
     workflows/global.fase1.json

# 3. No n8n: cria um workflow novo de teste → Import → global.fase1.json
#    Renomeia pra "GLOBAL [TESTE FASE 1]"

# 4. Compara canvas com o GLOBAL original.
#    Os 8 nós listados no CHANGELOG devem ter sumido.
#    Nenhum outro nó deve ter mudado.

# 5. Se OK, no n8n: GLOBAL original → Export (backup) → Import global.fase1.json
#    sobre o workflow de produção.
```

## Por que .original.json não está no git

Workflows exportados do n8n contêm IDs de credenciais e o `pinData` pode ter
mensagens reais de clientes (PII). O `.gitignore` exclui qualquer
`workflows/*.original.json` e `workflows/*.fase*.json` — guarde estes
arquivos fora do git.

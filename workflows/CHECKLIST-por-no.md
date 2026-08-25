# Checklist de correções, nó a nó

Ordem de aplicação. Detalhamento completo (com o código de cada nó) no guia publicado
em artifact; o JSON deste diretório já tem tudo aplicado.

Legenda: **CÓDIGO** = substituir o campo JavaScript · **CAMPO** = alterar um parâmetro ·
**SETTINGS** = aba Settings do nó · **NOVO** = criar e ligar · **PROMPT** = editar o texto do agente

## Grupo 1 — a correção obrigatória (resolve o bug do print)

| # | Nó | Tipo | O que fazer |
|---|----|------|-------------|
| 01 | `IDENTIFICA PLATAFORMA` | CÓDIGO | Lista de domínios: incluir `meli.la`, `mlb.la`, `shp.ee`, `amzn.eu`, `amzn.asia`. Fallback para o link cru do webhook. **Esta é a causa raiz.** |
| 02 | `Switch` | CAMPO | Options → Fallback Output = `Extra Output`; Rename Fallback Output = `desconhecida` |
| 03 | `Erro Plataforma` | NOVO | Code. Ligar: `Switch` saída `desconhecida` → aqui |
| 04 | `Respond Erro Plataforma` | NOVO | Respond to Webhook, parâmetros padrão. Ligar: `Erro Plataforma` → aqui |

## Grupo 2 — ramo Mercado Livre

| # | Nó | Tipo | O que fazer |
|---|----|------|-------------|
| 05 | `puppeter4` | CAMPO + SETTINGS | Body JSON lê de `IDENTIFICA PLATAFORMA.link_original`. Retry 3x / 2000ms, On Error = Continue |
| 06 | `Code in JavaScript14` | CÓDIGO | Lança erro explícito quando os 3 fallbacks falham |
| 07 | `HTTP fetch ML page` | CAMPO + SETTINGS | URL passa a ler de `Code in JavaScript14.link` (lia `puppeter4.url_limpa`, ignorando os fallbacks) |
| 08 | `HTML og:image` | SETTINGS | Always Output Data + On Error = Continue |
| 09 | `Edit Fields6` | — | **Sem mudança.** Já estava correto |
| 10 | `HTTP img ML2` | CAMPO + SETTINGS | `via.placeholder.com` (desativado em 2024) → `placehold.co` |
| 11 | `Extract File ML2` | SETTINGS | Always Output Data + On Error = Continue |
| 12 | `HTTP Request4` | SETTINGS | Retry 3x / 2000ms, Always Output Data, On Error = Continue |
| 13 | `Valida Produto ML` | NOVO | Code. Normaliza título/preço antes da IA. Ligar: `HTTP Request4` → aqui |
| 14 | `IF Dados ML` | NOVO | If, condição booleana `{{ $json.dados_ok }}` is true |
| 15 | `AI Agent9` | PROMPT | Bloco DADOS lê de `Valida Produto ML`; guard de `cupom = null`; regra 9 anti-placeholder |
| 16 | `Code in JavaScript15` | CÓDIGO | Imagem vem de `Valida Produto ML` |
| 17 | `Erro Dados ML` | NOVO | Code. Ligar: `IF Dados ML` saída **false** → aqui |
| 18 | `Respond Erro ML` | NOVO | Respond to Webhook. Ligar: `Erro Dados ML` → aqui |

Religação do ramo:
`HTTP Request4` → `Valida Produto ML` → `IF Dados ML` → **true**: `AI Agent9` · **false**: `Erro Dados ML` → `Respond Erro ML`

## Grupo 3 — Amazon

| # | Nó | Tipo | O que fazer |
|---|----|------|-------------|
| 19 | `Token OAuth Amazon` | CÓDIGO | Credenciais hardcoded → `$env.AMAZON_CLIENT_ID` / `$env.AMAZON_CLIENT_SECRET`. **Rotacionar as chaves** |
| 20 | `credenciais amazon1` | CÓDIGO | `marketplace` estava como markdown `[www.amazon.com.br](...)`; a Creators API rejeita. Usar o host puro |
| 21 | `Code in JavaScript` | CÓDIGO | Removidas referências a `puppeter1`, `pega imagem`, `pega imagem1` — nós que não existem |
| 22 | `AI Agent3` | PROMPT | Guard de `cupom = null` + regra 9 anti-placeholder |

## Grupo 4 — Shopee

| # | Nó | Tipo | O que fazer |
|---|----|------|-------------|
| 23 | `DESENCURTADOR_DE_LINK` | CAMPO | URL passa a ler de `IDENTIFICA PLATAFORMA.link_original` |
| 24 | `Code in JavaScript2` | CÓDIGO | `nodes[0].imageUrl` sem proteção estourava com `nodes: []`. Envolvido em try/catch |
| 25 | `AI Agent` | PROMPT | Guard de `cupom = null` + regra 9 anti-placeholder |

## Grupo 5 — Webhook

| # | Nó | Tipo | O que fazer |
|---|----|------|-------------|
| 26 | `Webhook` | CAMPO | Remover o `pinData`: fixava um link da **Shopee**, então o ramo do ML nunca era testado pelo editor |

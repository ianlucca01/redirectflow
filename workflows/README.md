# Fluxo PLANO — provisionamento de conta e assinatura

`plano-provisionamento.json` é a versão corrigida do workflow do n8n que recebe o
webhook de compra, cria a conta no WordPress, grava o usuário/assinatura no
Supabase e dispara e‑mail + WhatsApp.

---

## 1. O que aconteceu com a compra da Paloma (natalinapaloma97@gmail.com)

Verificado direto no Supabase (projeto `REDIRECT FLOW`):

| Verificação | Resultado |
|---|---|
| `usuarios` por e‑mail (`ilike '%natalinapaloma%'`) | **0 linhas** |
| `usuarios` por telefone (`%99852%`) | **0 linhas** |
| `assinaturas` alteradas na data da compra | **nenhuma** (todas as linhas recentes têm `updated_at = created_at`) |

Ou seja: a conta nunca foi criada, nenhuma assinatura foi gravada **e** nenhuma
assinatura de outro cliente foi sobrescrita por engano. A compra simplesmente
não provisionou nada.

## 2. Por que o fluxo antigo mandou ela para a renovação

O ponto de decisão era o nó `If`:

```
Get a row1  (Supabase get em `usuarios` por e‑mail, alwaysOutputData = true)
   └─> If   leftValue: {{ $item("0").$node["Get a row1"].json["email"] }}  →  operador "exists"
             saída 0 (true)  → Get a row  → renovação
             saída 1 (false) → cria a conta
```

Dois problemas somados:

1. **A checagem não lia a própria entrada do `If`.** Ela ia buscar o resultado
   por referência cruzada usando o acessor legado `$item("0").$node[...]`.
   Quando o `Get a row1` não encontra ninguém, ele não devolve linha nenhuma —
   o `alwaysOutputData` injeta um item vazio. Nesse cenário o `$item("0").$node[...]`
   não é determinístico: em vez de `undefined` ele pode resolver para o
   resultado de uma execução anterior do mesmo nó. Aí `email` "existe",
   o `If` vai para `true` e a compra cai na renovação.
2. **A renovação então quebra em silêncio.** O `Get a row` seguinte filtrava por
   `usuario_id = {{ $item("0").$node["If"].json["id"] }}`, que nesse caminho é
   `undefined`. Como `assinaturas.usuario_id` é `integer`, o PostgREST devolve
   erro de sintaxe (`eq.undefined`) e a execução morre ali — sem conta, sem
   assinatura, sem e‑mail.

Isso bate exatamente com o que o banco mostra. Para confirmar, procure a
execução dessa compra em **n8n → Executions** filtrando por erro: ela deve
aparecer como *failed* no nó `Get a row`, e o output do `Get a row1` mostra qual
das duas coisas aconteceu (0 linhas vs. linha de outro cliente).

## 3. O que mudou na versão corrigida

**Correção da causa raiz**

- As duas buscas (`usuarios` e `assinaturas`) agora são feitas por HTTP Request
  no PostgREST com **Full Response** ligado. O nó sempre devolve **exatamente um
  item** contendo `body` (o array de resultados), então a checagem vira
  `{{ $json.body.length > 0 }}` — determinística, sem depender de
  `alwaysOutputData` nem de item vazio. Autenticação pela credencial
  `supabaseApi` que já existe.
- **Nenhum `$item("0").$node[...]` restou no fluxo.** Todas as referências usam
  a sintaxe moderna `$('Nome do nó').first().json.campo`.

**Robustez**

- `Normaliza dados` faz `trim().toLowerCase()` no e‑mail (antes, um e‑mail com
  espaço ou maiúscula não batia com o cadastro e viraria cliente duplicado),
  `trim()` no nome e tira não‑dígitos do telefone.
- Os **dois `Switch` de plano viraram um único nó `Define plano`** (Code) com o
  mapa `valor → plano_id + limites + travas`. Eram 6 caminhos duplicados; agora
  há uma fonte única de verdade.
- **Valor de plano desconhecido agora falha explicitamente.** No fluxo antigo,
  se `total_value` não fosse exatamente 97/167/247 (order bump, cupom, valor
  como string), nenhuma saída do `Switch` batia e a execução terminava "com
  sucesso" sem provisionar nada. Agora o `Define plano` lança erro com e‑mail e
  valor recebido, e a execução aparece vermelha no n8n.
- **`starter_lock` / `inst_lock` / `sitebio_lock` são sempre setados nos três
  planos.** Antes, na renovação, quem subia de Starter para Profissional
  continuava com `starter_lock = true`, porque o update só ligava travas e nunca
  desligava.
- **Cliente que existe em `usuarios` mas não tem linha em `assinaturas`** agora
  cai num `INSERT` em vez de um `UPDATE` que afeta 0 linhas e mesmo assim manda
  "assinatura renovada".
- `retryOnFail` (3 tentativas, 2s) nas buscas e nas escritas no Supabase.

**Estrutura final** (17 nós, contra 23 antes, sem nenhum caminho duplicado):

```
PLANO → Normaliza dados → Busca usuario → Usuario ja existe?
                                            ├─ sim → Contexto - cliente existente ─┐
                                            └─ não → Cria conta WordPress          │
                                                     → Cria usuario                │
                                                     → Contexto - cliente novo ────┤
                                                                                   ↓
                                                                          Define plano
                                                                                   ↓
                                                                        Busca assinatura
                                                                                   ↓
                                                                       Ja tem assinatura?
                                                                     ├─ sim → Atualiza assinatura
                                                                     └─ não → Cria assinatura
                                                                                   ↓
                                                                            Cliente novo?
                                                          ├─ sim → Email boas-vindas → WhatsApp
                                                          └─ não → Email renovacao
```

## 4. Antes de importar

O JSON deste repositório está **sem segredos**. Depois de importar no n8n,
preencha os dois placeholders:

| Nó | Campo | Placeholder |
|---|---|---|
| `Cria conta WordPress` | header `Authorization` | `__TOKEN_WP_CREATE_USER__` |
| `WhatsApp boas-vindas` | header `token` | `__TOKEN_UAZAPI__` |

O ideal é cadastrá‑los como **credenciais do n8n** (Header Auth) em vez de texto
no nó, para não vazarem de novo em export/print.

O webhook mantém o mesmo `path` (`/plano`) e o mesmo `webhookId`, então a URL
registrada na plataforma de pagamento continua valendo.

## 5. Pendências recomendadas (não aplicadas aqui)

1. **Girar os dois tokens** (`create-user` do WordPress e o token da uazapi):
   ambos estavam em texto puro dentro do workflow e já circularam fora do n8n.
2. **Senha fixa `topafiliado` para todo mundo.** Todo cliente novo nasce com a
   mesma senha, enviada por e‑mail e WhatsApp em texto puro. Vale gerar senha
   aleatória por usuário ou mandar link de definição de senha.
3. **Renovação zera o período** (`data_inicio = agora`, `data_fim = agora + 31d`).
   Quem renova antes do vencimento perde os dias restantes. O correto seria
   `data_fim = max(data_fim_atual, agora) + 31d`. Mantido como estava para não
   mudar regra de negócio sem sua decisão.
4. **Configurar um Error Workflow** no n8n (Settings → Error Workflow) para que
   qualquer compra que falhe gere um alerta, em vez de você descobrir pelo
   cliente.
5. **Idempotência**: se a plataforma de pagamento reenviar o webhook, o fluxo
   roda de novo. A `UNIQUE (email)` em `usuarios` protege o cadastro, mas a
   assinatura pode ser reescrita. Vale guardar o id da transação.

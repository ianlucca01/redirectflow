# Por que o Mercado Livre não estava gerando oferta

## Causa raiz

O nó `IDENTIFICA PLATAFORMA` só reconhecia o ML por estas duas strings:

```js
link.includes("mercadolivre.com") || link.includes("mercadolibre.com")
```

O link do print é `https://meli.la/18T69ut`. **`meli.la` não contém nenhuma das duas** —
o mesmo vale para `mlb.la`. Resultado: `plataforma = "outra"`.

E aí vem o segundo problema: o `Switch` tinha só 3 saídas (mercadolivre / amazon / shopee)
e **nenhum fallback**. Item que não casa com nenhuma regra é descartado em silêncio.
Como não sobra nenhum caminho até um nó `Respond to Webhook`, a requisição do front
fica pendurada até dar timeout — sem erro, sem log, sem nada. O front cai no texto
genérico ("Produto Especial / Compre aqui: <link>"), que é exatamente o que aparece no print.

Isso só acontece quando o `DESENCURTADOR_DE_LINK5` (:3052) **não** consegue expandir o
`meli.la` — se ele expande, a URL final vira `mercadolivre.com.br/...` e o fluxo segue normal.
Ou seja: o bug é intermitente e depende do :3052, o que explica "às vezes funciona".

## O que foi corrigido

### 1. Detecção de plataforma (`IDENTIFICA PLATAFORMA`) — a correção principal
- Lista de domínios ampliada: `meli.la` e `mlb.la` para o ML; `shp.ee` para a Shopee;
  `amzn.eu` / `amzn.asia` para a Amazon.
- Se o `:3052` falhar, usa o `link_produto` cru do webhook em vez de quebrar
  (`link.includes` de `undefined` derrubava a execução inteira).
- Loga um aviso quando o link do ML chega ainda encurtado, para ficar visível na
  execução que o `:3052` não abriu.
- **Removido `a.co`** da lista da Amazon de propósito: `"casa.com"` contém `a.co` e
  classificaria errado.

### 2. `Switch` com saída de fallback
Nova saída `desconhecida` → `Erro Plataforma` → `Respond Erro Plataforma`.
Link não suportado agora responde `{success:false, erro:"..."}` em vez de pendurar a requisição.

### 3. Cadeia do ML deixou de morrer muda
- `puppeter4` (:3060): `retryOnFail` (3x) + `onError: continueRegularOutput`. VPS fora do ar
  não derruba mais o ramo — o fallback do `Code in JavaScript14` assume.
- `Code in JavaScript14`: passa a lançar erro explícito se os **três** fallbacks falharem,
  em vez de seguir com link vazio.
- `HTTP fetch ML page`: passou a ler o link de `Code in JavaScript14` em vez de
  `puppeter4.url_limpa` direto. O fallback existia um nó depois e esse nó o ignorava,
  então buscava a página com URL vazia justo no cenário em que o fallback foi escrito.
- `HTTP Request4` (:3099): `retryOnFail` (3x) + `onError` + `alwaysOutputData`.
- `via.placeholder.com` trocado — o serviço foi desativado em 2024 e a URL não resolve mais.

### 4. Novo `Valida Produto ML` + `IF Dados ML`
Quando o extrator `:3099` voltava vazio, o AI Agent recebia campos em branco e copiava o
template literal (`[Nome do Produto]`, `[PRECO_ATUAL]`). O guard do `Code in JavaScript15`
detectava e devolvia `success:false` **sem dizer o motivo**.

Agora a validação acontece **antes** da IA:
- normaliza preço em qualquer formato (`R$ 1.234,56`, `1234.56`, número) → `R$1.234,56`;
- omite o preço original quando é igual ou menor que o atual (evita o "De X / Por X");
- calcula o desconto quando o extrator não manda;
- sem título ou sem preço → não chama a IA, responde com erro explícito nomeando o link.

### 5. Prompts
- Placeholders `[PRECO_ORIGINAL]` / `[PRECO_ATUAL]` deixaram de ser escritos com colchetes
  (era o que o modelo copiava literalmente) e ganharam uma regra explícita proibindo copiá-los.
- `cupom` chega como `null` no payload; `cupom.nome` em cima de `null` quebrava a expressão.
  Todos os três agentes agora testam o objeto antes de acessar.

### 6. Amazon (achados de passagem)
- `marketplace` e `x-marketplace` estavam gravados como markdown:
  `"[www.amazon.com.br](https://www.amazon.com.br)"`. A Creators API rejeita isso —
  tem que ser o host puro. Corrigido para `www.amazon.com.br`.
- `Code in JavaScript` referenciava `$('puppeter1')`, `$('pega imagem')` e `$('pega imagem1')`,
  nós que **não existem** no workflow. Estavam dentro de `try/catch`, então falhavam calados.
  Limpo, mantendo só o caminho da Amazon + fallback de link.

## Ações necessárias do seu lado

1. **Rotacione as credenciais da Amazon.** O `client_id` e o `client_secret` estavam
   hardcoded no JSON. Eles foram trocados por `$env.AMAZON_CLIENT_ID` e
   `$env.AMAZON_CLIENT_SECRET` para não irem para o git — defina essas duas variáveis
   no ambiente do n8n antes de importar, senão o ramo da Amazon para.
   (Acesso a `$env` em Code node é liberado por padrão; só não funciona se
   `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` estiver setado.)

2. **O `pinData` foi removido.** Ele fixava um link da **Shopee** no webhook, então
   todo teste feito pelo editor do n8n ia para o ramo da Shopee — o ramo do ML nunca
   era exercitado. Provavelmente é parte de por que o problema passou despercebido.
   Para testar ML no editor, pin um link `meli.la` ou dispare pelo front mesmo.

3. **Confira o `:3052`.** Se ele estivesse expandindo `meli.la` corretamente, o bug de
   detecção não teria aparecido. Vale checar se ele segue redirect desse encurtador.

## Como testar

Importe `gerar-oferta-ia.json` e dispare:

```bash
curl -X POST https://webhook.redirectflow.online/webhook/gerar-oferta-ia \
  -H 'Content-Type: application/json' \
  -d '{"user_id":269,"link_produto":"https://meli.la/18T69ut","tom":"padrao","cupom":null}'
```

Os três desfechos possíveis agora **sempre** respondem:
- `{"success":true,"oferta":"...","imagem":"..."}`
- `{"success":false,"erro":"Nao foi possivel ler os dados do produto no Mercado Livre..."}`
- `{"success":false,"erro":"Plataforma nao suportada ou link nao desencurtado: ..."}`

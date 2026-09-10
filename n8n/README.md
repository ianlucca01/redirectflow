# Rodízio de Links — diagnóstico do erro "Erro ao sincronizar. Código: 500"

## O que é o 500

O `Código: 500` que aparece na tela **não é uma mensagem do WordPress**: é o status HTTP
que o n8n devolve quando a execução do workflow morre antes de chegar no node
`Respond to Webhook`. Como o webhook está em `responseMode: responseNode`, qualquer node
que estoure (ou um caminho que simplesmente não chegue no Respond) faz o n8n responder
500, e o JS do plugin só consegue mostrar o número.

Ou seja: para achar a causa exata, o lugar certo de olhar é
**n8n → Executions → a execução vermelha** → o node marcado em vermelho.

## As 5 causas prováveis no workflow que você colou

Em ordem de probabilidade:

### 1. `PreparaLoop` — `jids` indefinido (`Cannot read properties of undefined (reading 'map')`)

```js
const grupos_jids = $item("0").$node["Webhook1"].json.body.jids;
return grupos_jids.map(...)
```

Se o WordPress mandar o array com outro nome (`grupos_jids`, `groups`) ou não mandar
nenhum grupo, `.map` de `undefined` derruba a execução → 500. O próprio comentário no
código (`← Muda "grupos_jids" para "jids"`) mostra que o nome do campo mudou de um lado;
se o plugin não foi atualizado junto, é exatamente aqui que quebra.

### 2. Execução que termina sem passar pelo `Respond to Webhook1`

Se `PreparaLoop` devolver **zero itens** (nenhum JID), o `Loop Over Items` nunca roda,
`prepara final` nunca roda, o Respond nunca executa — e o n8n responde 500 mesmo sem
nenhum node vermelho. Sintoma clássico: execução "verde" e o WP mostrando 500.

### 3. `$item("0").$node[...]` dentro do loop (paired item)

`LINK_DO_GRUPO` e `PrepararDados` usam a sintaxe legada `$item("0").$node["..."]`.
Dentro de um `splitInBatches`, essa resolução de *paired item* falha
(`Paired item data ... is unavailable`) assim que um node no meio do caminho não
propaga o par — e isso também vira 500.

### 4. `buscar_inst` não acha a instância → token vazio → UAZAPI 401

No payload o WordPress manda `"token": null`, então o token real vem do Supabase
(`instancias_whatsapp.instance_name`). Repare no print: a tela está na instância
**`teste321`** (número 5516996352601), enquanto o payload fixado no workflow é
**`garimpamosofertas`**. Se a linha de `teste321` não existir no Supabase (ou estiver sem
`token`), o header `token` vai vazio, a UAZAPI responde 401, o node HTTP tenta 3x e
estoura → 500.

### 5. `deleta_links_gruposdefinidos_anteriormente` respondendo != 2xx

Esse node chama `https://rediirect.com/wp-json/redirect-flow/v1/grupos/deletar-todos-instancia`
sem tratamento de erro. Se a rota exigir autenticação (`permission_callback`), não existir,
ou der erro de PHP, o node falha e o workflow inteiro morre antes de gravar qualquer grupo.
Teste direto:

```bash
curl -i -X POST https://rediirect.com/wp-json/redirect-flow/v1/grupos/deletar-todos-instancia \
  -H 'Content-Type: application/json' \
  -d '{"instance_name":"teste321"}'
```

## O que mudou em `salvar-grupos.json`

Workflow corrigido, mesma estrutura e mesmos nomes de node, com estas mudanças:

| Mudança | Por quê |
| --- | --- |
| `PreparaLoop` aceita `jids`, `grupos_jids` e `groups`, e valida `rodizio_id`/`instance_name`/`token` | mata a causa 1 |
| Novo IF `entrada valida?` + node `resposta_erro` | payload inválido agora responde **200 com `{sucesso:false, erro:"..."}`** em vez de 500 mudo (causa 2) |
| Todas as expressões `$item("0").$node["X"]` viraram `$json` / `$('X').first().json` | mata a causa 3 |
| `buscar_inst`, `deleta_links...`, `LINK_DO_GRUPO` e o MySQL com `onError: continueRegularOutput` + `alwaysOutputData` | um grupo com problema (ou o WP fora do ar) não derruba mais os outros — causas 4 e 5 viram item ignorado com motivo |
| `PrepararDados` mantém a guarda `_gravar` e agora registra o `motivo` do descarte | evita `Column 'x' cannot be null` no `wp_rfa_grupos` |
| Novo node `marcar_gravado` | o node MySQL substitui o `json` pelo resultado da query; sem isso o resumo final perdia os dados do grupo |
| `prepara final` devolve um objeto único `{sucesso, total, gravados, pulados, grupos[], ignorados[]}` | o `Respond to Webhook` com `{{ $json }}` só devolve o **primeiro** item — antes, com vários grupos, o WP recebia só um |

## Atenção ao importar

1. **Contrato de resposta mudou.** A resposta agora é sempre
   `{sucesso, total, gravados, pulados, grupos, ignorados}`. Se o PHP do plugin lê algum
   campo do formato antigo (ex.: `invite_link` na raiz), ajuste lá — ou me diga o trecho
   que eu adapto o `prepara final`.
2. **`pinData` continua no arquivo.** Ela só vale para execução manual no editor; em
   produção o webhook usa o payload real. Se for testar `teste321`, edite o pin.
3. **`columnToMatchOn: whatsapp_group_id` exige índice UNIQUE nessa coluna** do
   `wp_rfa_grupos`. Sem o índice, o upsert vira insert e duplica grupos a cada sync.
   Se o mesmo JID puder aparecer em rodízios diferentes, o índice deveria ser composto
   `(rodizio_id, whatsapp_group_id)` — e aí o match do node precisa mudar junto.
4. **Esse workflow é o `salvar-grupos`** (salvar a seleção). Se a mensagem "Erro ao
   sincronizar" aparece ao **abrir a página** ou ao clicar em *Sincronizar*, o 500 vem de
   outro endpoint (o que lista os grupos da UAZAPI) — nesse caso me manda esse outro
   workflow/rota que eu analiso.

## Checklist rápido de verificação

```
1. n8n → Executions → workflow salvar-grupos → última execução vermelha → node vermelho + mensagem
2. Supabase → instancias_whatsapp → existe a linha com instance_name = 'teste321' e token preenchido?
3. curl na rota deletar-todos-instancia (comando acima) → tem que voltar 200
4. Log do PHP em rediirect.com (wp-content/debug.log) na hora do erro
5. DevTools → aba Network → qual URL exatamente devolveu 500 (n8n ou wp-json?)
```

O item 5 é o mais decisivo: se a URL que deu 500 for `rediirect.com/wp-json/...`, o
problema é PHP no plugin e não o n8n.

# Workflow de Reembolso — Digital Guru Manager

Automação n8n que **desativa a assinatura do cliente** no Supabase assim que a
Digital Guru Manager (Guru) envia um webhook de **reembolso**.

Arquivo: [`reembolso-guru.json`](./reembolso-guru.json) — importe direto no n8n
(menu **⋯ → Import from File**).

## Fluxo

```
Webhook (POST /reembolso)
        │
        ▼
   É reembolso?   ── (status != refunded) ──▶ nada acontece (retorna 200)
        │ (status == refunded)
        ▼
   Get a row  (usuarios, busca por contact.email)
        │
        ▼
   Update a row (assinaturas → data_fim = agora, status = "inative")
```

## O que mudou em relação ao webhook antigo (Kiwify)

O payload da Guru tem uma estrutura diferente da Kiwify. Os pontos ajustados:

| Dado                | Kiwify (antigo)                 | Digital Guru Manager (novo) |
| ------------------- | ------------------------------- | --------------------------- |
| E-mail do cliente   | `body.Customer.email`           | `body.contact.email`        |
| Status do pedido    | `body.order_status` (`refunded`)| `body.status` (`refunded`)  |
| Tipo do evento      | `body.webhook_event_type`       | `body.webhook_type`         |

Também foi adicionado o nó **"É reembolso?"** (IF) para garantir que a
desativação só ocorra quando `status == refunded`, mesmo que o webhook seja
disparado para outros status ou receba o teste/ping da Guru.

## Como configurar o webhook na Digital Guru Manager

1. No painel da Guru, acesse **Configurações → Webhooks → Novo webhook**.
2. Em **URL**, informe:
   `https://n8n.redirectflow.com.br/webhook/reembolso`
3. Em **Recurso/Tipo**, selecione **Transação**.
4. Em **Status**, marque **Reembolsada / Estornada** (e, se quiser, também
   **Chargeback** — veja abaixo).
5. Salve. A Guru envia um POST de teste; o fluxo responde `200` e ignora
   (não é `refunded`).

> A Guru considera o webhook entregue apenas se a resposta HTTP for `200`.
> O nó Webhook do n8n já responde `200` por padrão.

## Observações

- **Chargeback também?** Se quiser desativar também em chargeback, abra o nó
  **"É reembolso?"**, mude o combinador para **OR** e adicione uma condição
  `{{ $json.body.status }}` **equals** `chargedback`.
- **Valor do status `"inative"`**: mantido igual ao workflow original para não
  quebrar o enum atual da tabela `assinaturas`. Se o valor correto no seu banco
  for outro (ex.: `inativa` / `inactive`), ajuste no nó **Update a row**.
- **Credenciais Supabase**: o JSON referencia a credencial `Supabase account`
  (id `0EpUhAk2WvhnrKZb`). Ao importar, confirme se ela está selecionada nos
  nós **Get a row** e **Update a row**.
- **`pinData`**: o nó Webhook vem com um exemplo de payload de reembolso da Guru
  para você testar (**Execute Workflow**) sem precisar de um reembolso real.

## Validação contra a documentação oficial

Estrutura conferida contra o exemplo oficial de payload
(`api.docs.digitalmanager.guru/webhooks-vendas`, fornecido pelo suporte da Guru):

- `contact.email` → e-mail do cliente ✅
- `status` (raiz) → status da transação; `refunded` = Reembolsada ✅
  (`requested_refund` = Reembolso solicitado, caso queira tratar no futuro)
- `webhook_type: "transaction"` ✅
- `api_token` → chave para validar a origem do POST ✅

## Recomendações de robustez (opcional)

- **Validar assinatura do webhook**: a Guru envia um `api_token`/assinatura.
  Vale conferir esse valor antes de agir, para não aceitar POSTs forjados.
- **Cliente não encontrado**: se o e-mail do reembolso não existir em
  `usuarios`, o "Get a row" volta vazio e o update não encontra linha para
  atualizar (nada é alterado). Se quiser tratar esse caso explicitamente,
  adicione um IF após o "Get a row".

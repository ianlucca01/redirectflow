# Fluxo Telegram — n8n

`fluxo-telegram.json` é o workflow que captura ofertas de canais do Telegram,
identifica a plataforma (Shopee / Mercado Livre / Amazon), gera o link de
afiliado do cliente, reescreve a copy e dispara nos grupos via UAZAPI.

Importe no n8n por **Workflows → Import from File**. As credenciais
(`Supabase account`, `OpenRouter account 2`, etc.) são referenciadas por ID e
precisam existir na instância.

## Correções aplicadas (2026-06-13)

Quatro bugs reportados em produção foram corrigidos. A raiz comum era depender
do LLM (AI Agent) para limpar o texto/escolher o link, o que falhava de forma
intermitente.

### 1 + 3 — Link enviado sem encurtar / "Compre aqui" duplicado (um sem link)
- **Causa:** a remoção dos links e rótulos originais era feita só pelo LLM
  (regra #5 do prompt). Quando ele falhava, sobrava o link original (longo) ou
  um rótulo `Compre aqui:` vazio — e como os nodes `Preparar Mensagem Final`
  sempre adicionam `Compre aqui: <link de afiliado>`, o texto ficava duplicado.
- **Fix:** `Code in JavaScript3` agora faz uma **limpeza determinística**
  (`limparTexto`) que remove todas as linhas com URL e os rótulos de CTA antes
  de qualquer branch. O link de afiliado correto é adicionado depois, uma única
  vez.

### 2 — Link errado / link de outro grupo (espelhamento)
- **Causa:** havia duas seleções de link concorrentes. O roteamento usava o
  link do AI (`DESENCURTADOR_DE_LINK1`), mas o branch do Mercado Livre
  (`puppeter`) processava um link diferente vindo do heurístico
  `Code in JavaScript7` (`DESENCURTADOR_DE_LINK4`). Em promoções espelhadas (com
  vários links na legenda) os dois divergiam e o produto/link errado era enviado.
- **Fix:** `puppeter` passou a usar `DESENCURTADOR_DE_LINK1` — o mesmo link que
  o `Switch` roteou. A limpeza determinística do item 1 também remove links de
  terceiros que sobravam no texto.

### 4 — Link de resgate da Shopee quase nunca enviado
- **Causa:** dois problemas de fiação. (a) O branch dedicado de cupom
  (`If4 = true`) morria no `Code in JavaScript9`, que procurava um campo
  `instance_name` inexistente em `DADOS_USUARIO`. (b) A substituição feita em
  `Code in JavaScript13` era descartada, pois `Preparar Mensagem Final7` lia o
  `texto_formatado` cru do `Code in JavaScript3`. O campo `resgate-shopee` do
  cliente era buscado do banco mas **nunca usado**.
- **Fix:** o `Code in JavaScript3` agora vai direto para `DESENCURTADOR_DE_LINK1`
  (caminho unificado e funcional; o branch quebrado do topo fica órfão).
  `Preparar Mensagem Final4` (Shopee) passa a **anexar deterministicamente** o
  `DADOS_USUARIO["resgate-shopee"]` quando há cupom — detectado pela flag do AI
  **ou** pelas frases de resgate no texto original.

## Observação sobre os modelos de IA

As sticky notes dizem que os AI Agents rodam no **Google Gemini direto**, mas a
fiação real conecta o **OpenRouter (`gpt-4o-mini`)** aos três agentes. Os nodes
`Google Gemini Chat Model*` e `OpenAI Vinicius` estão no canvas mas
desconectados. Isto foi mantido como está (não faz parte dos bugs reportados),
mas vale alinhar a documentação com a realidade num próximo passo.

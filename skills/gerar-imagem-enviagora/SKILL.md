---
name: gerar-imagem-enviagora
description: Gera imagens pelo servidor de imagens da Enviagora (connector enviagora_mcp). Use SEMPRE que alguém pedir uma imagem, arte, foto, ilustração, banner, post, capa, story, thumbnail, mockup, fundo de slide ou qualquer peça visual — inclusive quando o pedido for vago ("faz uma imagem disso", "preciso de uma arte pro post", "me dá uma foto de galpão"). A skill decide sozinha a qualidade, o formato e se aplica a identidade visual da Enviagora, e escreve o prompt a partir do pedido em linguagem comum, para que ninguém precise saber o que é modelo, resolução ou prompt. Dispara com "gera uma imagem", "cria uma arte", "faz um post", "preciso de um banner", "uma foto de", "uma ilustração", "capa para", "imagem pro site", "imagem pra apresentação", "story", "arte pro Instagram", "mockup".
---

# Gerar imagem — Enviagora

O connector `enviagora_mcp` expõe uma ferramenta, `gerar_imagem`. Quem usa são
~170 pessoas da Enviagora, quase nenhuma técnica. Elas descrevem o que querem em
linguagem comum e esperam receber a imagem.

**Você preenche todos os parâmetros.** A pessoa não escolhe modelo, resolução nem
proporção, e não deveria nem saber que isso existe. Se você perguntar "qual
finalidade?" ou "quer 4K?", a ferramenta falhou no propósito dela.

## Decida, não pergunte

Gere com a sua melhor interpretação e ofereça ajuste depois. Uma imagem gerada em
15 segundos que a pessoa pede para mudar é melhor que três perguntas antes de
qualquer coisa aparecer.

A única pergunta que vale a pena é quando o pedido é tão aberto que qualquer
imagem seria chute — "faz uma arte bonita", sem assunto. Aí pergunte **o que** é
para aparecer na imagem, nunca detalhe técnico.

## `finalidade` — a qualidade

Custa dez vezes mais a cada degrau, então vale acertar.

| Use | Quando | Custo |
|---|---|---|
| `final` | **Padrão.** Qualquer imagem que vai ser usada: post, site, apresentação, e-mail, proposta, documento. Na dúvida, é esta. | US$ 0,03 |
| `rascunho` | A pessoa está explorando ("me dá umas ideias", "só pra ver como fica", "umas três opções"), ou você vai gerar várias variações. | US$ 0,003 |
| `impressao` | Ela falou em **imprimir**: banner físico, lona, adesivo, embalagem, cartaz, peça grande, ou pediu 4K. | US$ 0,30 |

Quando gerar várias opções de uma vez, use `rascunho` nas opções e regere só a
escolhida em `final`. Isso dá à pessoa o mesmo resultado por uma fração do custo.

O serviço tem teto de gasto diário compartilhado entre todo mundo. Não é motivo
para economizar numa imagem que vai ser publicada — é motivo para não gerar dez
variações em `impressao`.

## `formato` — a proporção

Deduza do destino que a pessoa mencionou.

| Use | Quando |
|---|---|
| `quadrado` | Post de feed, avatar, ícone, ou nada indicado e o assunto é um objeto ou produto |
| `horizontal` | Site, banner, capa, slide, e-mail, cabeçalho, ou uma cena ampla (galpão, doca, operação) |
| `vertical` | Post vertical de feed, cartaz, peça impressa em pé |
| `story` | Story, reels, TikTok, ou quando falarem em tela cheia de celular |

## `marca` — a identidade visual

Use `marca: true` quando a peça **representa a Enviagora**: institucional, post
da empresa, apresentação comercial, capa de proposta, material de RH, foto de
operação para uso da marca.

Use `marca: false` (o padrão) para imagem avulsa que só ilustra alguma coisa: um
ícone, uma foto genérica para um slide interno, uma ilustração de conceito, algo
para uso pessoal.

Na dúvida, olhe para quem vai ver a peça. Se for cliente ou público, ligue a
marca. Se for material interno de trabalho, deixe desligada.

Com `marca: true` o servidor injeta a paleta, a direção de fotografia e a
composição do manual — você não precisa citar cor, fonte nem regra de marca no
prompt. E ele instrui o modelo a **não desenhar o logotipo**, porque logo feito
por IA sempre sai errado; o designer compõe o arquivo oficial depois.

## `prompt` — o que você escreve

Aqui está o trabalho de verdade. O pedido chega vago e sai como uma descrição de
cena concreta. Escreva sempre em terceira pessoa, descrevendo a imagem, não o
pedido.

Preencha o que a pessoa não disse, guiado pelo que a Enviagora faz — fulfillment
para e-commerce de cosméticos, suplementos, beleza e performance:

- **Sujeito**: o que aparece, e em que estado
- **Ambiente**: onde, com que profundidade de campo
- **Luz**: direção, dureza, hora do dia
- **Ângulo**: altura da câmera, distância, lente
- **Detalhe concreto**: um ou dois elementos que ancoram a cena

**Exemplo 1**
Pedido: "gera uma imagem do galpão"
Prompt: `Interior de um centro de distribuição moderno, vista do corredor central entre porta-pallets de sete níveis carregados de caixas paletizadas. Ao fundo, estações de conferência com operadores trabalhando. Luz dura entrando pelas claraboias, sombras marcadas no piso de concreto polido com demarcação de segurança. Câmera na altura dos olhos, lente 35mm, profundidade longa.`

**Exemplo 2**
Pedido: "uma arte pro story falando de frete"
Prompt: `Close de uma caixa de papelão lacrada com fita, sendo entregue de mão em mão na porta de uma residência. Luz do fim da tarde, contraluz suave nas bordas. Composição vertical com o objeto no terço inferior e espaço limpo na parte de cima.`
(`formato: story`, e o espaço limpo em cima é para o texto entrar depois.)

**Exemplo 3**
Pedido: "foto de um frasco de sérum bonita"
Prompt: `Macro de um frasco de sérum de vidro âmbar com conta-gotas, sobre superfície de pedra clara. Gotas de água na superfície do vidro. Luz dura lateral criando uma sombra longa e definida. Fundo liso, desfocado. Ângulo levemente acima da linha do produto.`

Duas coisas que não funcionam: pedir texto dentro da imagem (modelos de imagem
erram letra e acento com frequência, então deixe o texto para quem for editar
depois) e descrever em negativa ("sem pessoas") — descreva o que **deve** estar
lá.

Pode escrever o prompt em português ou inglês; o servidor lida com os dois.

## Depois de gerar

A imagem volta junto com um link de download válido por 7 dias.

Responda em uma ou duas frases: o que a imagem mostra e o que a pessoa pode
pedir em seguida — outro formato, outro ângulo, versão sem marca. Não recite
modelo, resolução nem custo; se ela perguntar, aí sim responda.

Se você notar um defeito real no resultado — mão deformada, texto embaralhado,
elemento cobrindo o assunto — diga e ofereça regerar. É melhor do que entregar
algo torto e deixar a pessoa descobrir sozinha.

## Quando dá errado

**Teto de gasto atingido.** O serviço gastou o limite do dia. Explique em
linguagem simples que o limite diário acabou e que zera na virada do dia, e
sugira falar com quem administra o serviço se for urgente. Não tente de novo.

**Prompt recusado.** O filtro de conteúdo do modelo barrou. Reescreva
descrevendo a cena de outro jeito e tente uma vez; se barrar de novo, diga o que
aconteceu em vez de insistir.

**A ferramenta não aparece.** A pessoa provavelmente não conectou o connector
Enviagora, ou a autorização dela expirou. Oriente a ir em Configurações →
Conectores e conectar o **Enviagora_MCP**, entrando com a conta
`@enviagora.com.br`.

## `estimar_custo`

Existe uma segunda ferramenta que diz quanto custaria um lote e quanto ainda
cabe no teto do dia. Use antes de gerar muitas imagens de uma vez, ou quando
perguntarem o preço. Para uma imagem só, não vale a chamada — gere direto.

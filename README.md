# Enviagora · MCP de geração de imagem

Servidor MCP que dá ao Claude a capacidade de gerar imagens. Roda no Google
Cloud Run, guarda a credencial da Replicate do lado do servidor e expõe uma
ferramenta simples, usável por quem nunca ouviu falar de "difusão" ou
"Seedream".

Ninguém do time precisa de token, conta ou configuração. Basta pedir a imagem
no Claude.

```
Claude (org Enviagora)
   │  MCP / Streamable HTTP  ─ autenticado por OAuth 2.1
   ▼
Cloud Run  ──► Secret Manager (REPLICATE_API_TOKEN e segredos de OAuth)
   │
   ├──► Replicate API (geração)
   ├──► Cloud Storage (imagem + URL assinada de 1h)
   └──► Cloud Logging (auditoria e custo estimado)
```

---

## As ferramentas

Só duas, de propósito: cada ferramenta registrada consome contexto em **toda**
conversa do Claude, mesmo quando ninguém gera imagem.

### `gerar_imagem`

| Parâmetro | Tipo | Obrigatório | Padrão | Observação |
|---|---|---|---|---|
| `prompt` | string | sim | — | Descrição em português ou inglês |
| `finalidade` | enum | não | `rascunho` | `rascunho` \| `final` \| `impressao` |
| `formato` | enum | não | `quadrado` | `quadrado` \| `vertical` \| `horizontal` \| `story` |
| `marca` | boolean | não | `false` | Injeta as diretrizes visuais da Enviagora |
| `referencia` | string (URL) | não | — | Imagem de referência https:// pública |

Devolve a imagem como conteúdo visual do MCP **e** a URL assinada do Cloud
Storage, mais o modelo usado e o custo estimado em USD.

O usuário nunca escolhe modelo. `finalidade` escolhe por ele.

### `estimar_custo`

Recebe `finalidade` e `quantidade`, devolve o custo e quanto ainda cabe no teto
do dia. Serve para o Claude avisar antes de gerar um lote grande.

---

## Modelos e custo

Slugs, schemas e preços **confirmados direto nas páginas dos modelos na
Replicate em 2026-09-11**. Replicate cobra por imagem de saída nestes três
modelos (métrica `image_output_count`), não por segundo de GPU.

| Finalidade | Modelo | Resolução | Custo/imagem | Referência? |
|---|---|---|---|---|
| `rascunho` | `black-forest-labs/flux-schnell` | ~1 MP | **US$ 0,003** | não |
| `final` | `bytedance/seedream-4` | 2K (2048 px) | **US$ 0,03** | sim (até 10) |
| `impressao` | `google/nano-banana-pro` | 4K (4096 px) | **US$ 0,30** | sim (até 14) |

> **Divergência em relação ao briefing, registrada de propósito.** O briefing
> estimava US$ 0,13 a 0,24 para a faixa de impressão. O preço real do
> Nano Banana Pro na Replicate hoje é **US$ 0,15 em 1K/2K e US$ 0,30 em 4K** —
> o dobro do topo da estimativa. Como "impressão" pede 4K de verdade, o
> mapeamento ficou em 4K e US$ 0,30, e o custo aparece no retorno da ferramenta
> toda vez. Se US$ 0,30 pesar demais, há duas saídas de uma linha cada:
> trocar `impressao` para `bytedance/seedream-4` (que também faz 4K, por
> US$ 0,03, com menos fidelidade de texto), ou baixar o Nano Banana Pro para 2K
> em `src/config/models.ts` e cair para US$ 0,15.

### Trocar o modelo de uma finalidade

Uma linha em [`src/config/models.ts`](src/config/models.ts):

```ts
export const MODELO_POR_FINALIDADE: Record<Finalidade, ModeloSlug> = {
  rascunho: 'black-forest-labs/flux-schnell',
  final: 'bytedance/seedream-4',        // <- troque aqui
  impressao: 'google/nano-banana-pro',
};
```

O catálogo no mesmo arquivo já traz preço, schema e suporte a referência de
`flux-dev`, `flux-1.1-pro`, `flux-1.1-pro-ultra`, `nano-banana`,
`ideogram-v3-quality`, `recraft-v3` e `qwen-image`, prontos para entrar. Para um
modelo fora do catálogo, adicione uma entrada com o `buildInput` dele — cada
modelo aceita um conjunto diferente de `aspect_ratio`, e é esse adaptador que
traduz `formato` para o valor que aquele modelo entende.

---

## Controle de gasto

- Teto diário em `TETO_DIARIO_USD` (**começa em US$ 10**).
- O custo é **debitado antes** de chamar a Replicate e estornado se a geração
  falhar. Debitar depois deixaria várias gerações simultâneas passarem juntas
  pelo teto.
- Ao atingir o teto, `gerar_imagem` recusa com um erro explicativo e **não
  gera** — nada é cobrado.
- O contador zera na virada do dia em `FUSO_HORARIO` (padrão
  `America/Sao_Paulo`), não em UTC: "teto diário" tem que bater com o dia de
  quem usa.
- Toda geração vira uma linha de JSON no stdout, que o Cloud Run entrega ao
  Cloud Logging como `jsonPayload`.

Campos do log de auditoria (`evento: "geracao_imagem"`): `modelo`,
`finalidade`, `formato`, `marca`, `com_referencia`, `custo_estimado_usd`,
`gasto_acumulado_dia_usd`, `teto_diario_usd`, `prompt_hash`, `prompt_chars`,
`duracao_ms`, `status` (`ok` | `erro` | `bloqueado_por_teto`).

O prompt em si **não** vai para o log — só o hash SHA-256 truncado e o tamanho.
Dá para agrupar reincidência sem despejar conteúdo de cliente no Cloud Logging.

Custo do dia por finalidade:

```bash
gcloud logging read \
  'jsonPayload.evento="geracao_imagem" AND jsonPayload.status="ok"' \
  --freshness=1d --format='value(jsonPayload.finalidade,jsonPayload.custo_estimado_usd)'
```

### Testar o teto

Sem gastar nada, subindo o serviço com um teto abaixo do custo de uma imagem:

```bash
TETO_DIARIO_USD=0.001 REPLICATE_API_TOKEN=qualquer-coisa npm run dev
# qualquer chamada a gerar_imagem recusa antes de falar com a Replicate
```

### Atribuição por pessoa

O briefing previa que o log ficasse agregado, sem saber quem pediu cada imagem.
Com o login pelo Google Workspace isso deixou de ser necessário: o e-mail de quem
autorizou viaja dentro do próprio access token (assinado, não armazenado) e
aparece no campo `solicitante` de cada geração no Cloud Logging.

```bash
gcloud logging read 'jsonPayload.evento="geracao_imagem" AND jsonPayload.status="ok"' \
  --freshness=7d --format='value(jsonPayload.solicitante,jsonPayload.custo_estimado_usd)'
```

Duas ressalvas honestas:

- O **teto de gasto continua sendo do serviço**, não por pessoa. O log diz quem
  gastou; ele não impede ninguém individualmente.
- Quando o servidor roda com a senha compartilhada em vez do Google (nenhum
  `GOOGLE_CLIENT_ID` configurado), não há identidade para registrar e o campo sai
  como `nao-identificado`.


### Contador em memória

O contador vive na memória do processo, e o `cloudbuild.yaml` fixa
`--max-instances=1` justamente para que o contador seja o gasto real. O
`subir.sh` confere isso a cada implantação e corrige se estiver diferente: com N
instâncias, cada uma teria o próprio contador e o teto diário passaria a valer N
vezes — um limite de gasto que não limita é pior que nenhum, porque dá falsa
segurança. Se um dia
o serviço precisar escalar, o contador deixa de ser confiável: troque
`src/budget.ts` por Firestore mantendo a mesma interface
(`reservar` / `devolver` / `estado`). Nada mais no código muda.

Um cold start no meio do dia também zera o contador — o serviço roda com
`min-instances=0`. O teto continua protegendo contra o lote acidental grande,
que é o risco real, mas não é um limite contábil exato. Para isso, use também
um **orçamento com alerta** no Billing do GCP e o limite de gasto da própria
conta da Replicate.

---

## Camada de marca

Com `marca: true`, o prompt do usuário recebe as diretrizes do sistema visual
**"Autoridade Técnica"** (redesign 2026): paleta exata (verde profundo
`#123336`, verde neon `#C4FF57`, creme `#FAFAF5`, cinza névoa `#DEE3E0`),
um único acento neon por peça, composição em grid modular, tipografia
geométrica em caixa alta, fotografia de luz dura em operação real.

Tudo isso vive em um arquivo só: [`src/config/marca.ts`](src/config/marca.ts).
Se o manual mudar, muda ali.

Com `marca: false` (o padrão) nada de marca entra no prompt — gerar uma imagem
avulsa continua sendo uma imagem avulsa.

**O modelo é instruído a NÃO desenhar o logotipo.** O wordmark ENVIAGORA e a
seta são arquivos vetoriais oficiais; o que uma IA generativa desenha no lugar
deles é marca errada. O prompt pede espaço negativo limpo para o logo ser
composto depois, no arquivo certo.

---

## Rodar local (fase 1)

Não precisa de GCP.

```bash
npm install
cp .env.example .env
# preencha REPLICATE_API_TOKEN no .env — ele está no .gitignore
npm run dev
```

Sem `GCS_BUCKET`, as imagens vão para `./.imagens-locais/` e a ferramenta
devolve o caminho do arquivo em vez da URL assinada.

Com o inspector do MCP:

```bash
npm run inspector
# Transport: Streamable HTTP
# URL:       http://localhost:8080/mcp
# Header:    Authorization: Bearer <o valor de MCP_STATIC_TOKEN>
```

---

## Deploy (fase 2)

```bash
PROJECT_ID=enviagora-mcp ./scripts/bootstrap-gcp.sh
```

O script habilita as APIs, cria o Artifact Registry, a conta de serviço, o
bucket privado (com expurgo em 90 dias), os papéis mínimos e os segredos. Ele
pede o token da Replicate e a senha de acesso no terminal e grava direto no
Secret Manager — nada toca o disco nem o histórico do shell. É idempotente.

Com a infraestrutura no lugar, um comando faz o resto:

```bash
./scripts/subir.sh
```

Ele constrói, implanta, corrige o `ingress` se estiver fechado, espera o serviço
responder, e termina rodando o teste ponta a ponta — que passa pelo OAuth como o
Claude passaria e gera uma imagem de verdade. Se algo falhar, ele já despeja o
log do build ou do container junto com o erro, em vez de deixar você caçar.
Pode rodar quantas vezes quiser; nada nele é destrutivo.

Para deploy contínuo, conecte o repositório em **Cloud Build → Gatilhos** e crie
o gatilho para `cloudbuild.yaml` no branch `main`.

### Diagnóstico remoto

Quando for preciso investigar o serviço sem ficar copiando saída de terminal:

```bash
./scripts/token-leitura.sh
```

Ele cria (uma vez) a conta `mcp-leitor`, com papéis apenas de leitura em Cloud
Run, Logging, Cloud Build e Artifact Registry, e imprime um token válido por
**1 hora** gerado por impersonação — não existe arquivo de chave em lugar
nenhum.

Esse token não alcança o Secret Manager: nem o token da Replicate, nem a senha
do OAuth. Também não implanta, não apaga e não mexe em IAM. Ele expira sozinho,
e a linha de revogação sai impressa junto.

**Nunca use chave de service account (`.json`) para isso.** Ela é permanente,
larga e não tem como ser revogada sem virar trabalho — é justamente o que este
projeto evita ao manter tudo no Secret Manager.

**Projeto novo exige conta de serviço explícita no gatilho.** Projetos criados
depois de maio/2024 não recebem a conta legada
`PROJECT_NUMBER@cloudbuild.gserviceaccount.com`; o build passa a usar a conta
padrão do Compute Engine e o gatilho exige que você escolha uma conta. Use a
`mcp-deployer@<projeto>.iam.gserviceaccount.com` que o bootstrap cria — é por
isso também que o `cloudbuild.yaml` traz `logging: CLOUD_LOGGING_ONLY`, que é
obrigatório quando o build roda com conta gerenciada por você.

**`BASE_URL` é previsível.** A URL determinística do Cloud Run é
`https://<serviço>-<número do projeto>.<região>.run.app`, então o
`cloudbuild.yaml` a monta sozinho com a substituição `$PROJECT_NUMBER` e o OAuth
já sobe com o `BASE_URL` certo no primeiro deploy. Confirme depois com
`gcloud run services describe imagegen --region=... --format='value(status.url)'`
e, se por algum motivo a URL sair diferente, fixe `BASE_URL` à mão.

**Por que `--no-invoker-iam-check` e não `--allow-unauthenticated`.** A
organização `enviagora.com.br` tem *domain restricted sharing* ligado
(`constraints/iam.allowedPolicyMemberDomains`, restrito ao customer ID do
Workspace). Essa política bloqueia qualquer binding de IAM para `allUsers`, que
é exatamente o que `--allow-unauthenticated` tenta criar. A flag
`--no-invoker-iam-check` desliga a checagem de invoker do Cloud Run **sem criar
binding nenhum**, então não esbarra na política — é o caminho que a
documentação do Cloud Run recomenda justamente para projeto sujeito a ela.

O endpoint continua protegido: quem autoriza é o OAuth da aplicação, não o IAM
do Google. Ou seja, o IAM nunca foi a camada de segurança aqui — ele só decidia
quem consegue bater na porta, e a porta tem fechadura própria.

Se um dia quiser voltar para o modelo com IAM, o caminho é um admin da
organização criar uma política customizada com exceção para `allUsers` (a
constraint antiga não aceita exceção), e trocar a flag no `cloudbuild.yaml`.
**Sobre a URL assinada:** a conta de serviço não tem chave privada em disco — a
assinatura v4 é feita pela API `iamcredentials.signBlob`, e é por isso que o
bootstrap dá a ela `roles/iam.serviceAccountTokenCreator` sobre si mesma. Sem
esse papel, a geração funciona mas a URL assinada falha.

---

## Conectar no Claude (fase 3)

A documentação atual de connectors custom do Claude oferece, em **Advanced
settings**, um par **OAuth Client ID / Client Secret**. **Não existe campo para
header estático de requisição** — por isso a opção 1 do briefing não é viável
hoje, e o servidor implementa a opção 2: um OAuth 2.1 mínimo de cliente único.

Como funciona:

- Metadados em `/.well-known/oauth-protected-resource` (RFC 9728) e
  `/.well-known/oauth-authorization-server` (RFC 8414) — é o que evita a falha
  de conexão de connector gerenciado pela organização.
- **PKCE S256 obrigatório.** Sem `code_challenge`, o `/authorize` recusa.
- **Sem registro dinâmico de cliente.** O `registration_endpoint` foi omitido de
  propósito: o cliente é único e configurado à mão. Registro aberto deixaria
  qualquer um pedir credencial a este servidor.
- Quem autentica a pessoa é o **Google Workspace da Enviagora**: o `/authorize`
  redireciona para a tela de conta do Google e só aceita quem volta com o claim
  `hd` igual a `enviagora.com.br`. Ninguém digita senha, e quem sai da empresa
  perde o acesso junto com a conta corporativa.
- A senha compartilhada (`OAUTH_SENHA`) continua no código como alternativa e é
  usada quando `GOOGLE_CLIENT_ID` está vazio — é o que mantém o desenvolvimento
  local funcionando sem depender do Google.
- Os tokens são **assinados, não armazenados** (HMAC-SHA256 com
  `OAUTH_ASSINATURA`). Com `min-instances=0`, uma tabela em memória obrigaria
  todo mundo a reautorizar a cada cold start.
- Access token dura 8 h, refresh token 30 dias.

### Criar o cliente OAuth do Google (uma vez)

1. No console do GCP, **APIs e serviços → Tela de permissão OAuth**: tipo
   **Interno**, para só aceitar contas da organização.
2. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da web**.
   Em *URIs de redirecionamento autorizados*, adicione exatamente:

   ```
   https://<URL do serviço>/auth/google/callback
   ```

3. Guarde o par no Secret Manager com estes nomes — é a existência do primeiro
   que liga o login pelo Google no próximo deploy:

   ```bash
   gcloud secrets create google-oauth-client-id     --data-file=-
   gcloud secrets create google-oauth-client-secret --data-file=-

   for s in google-oauth-client-id google-oauth-client-secret; do
     gcloud secrets add-iam-policy-binding $s \
       --member="serviceAccount:mcp-imagegen@<projeto>.iam.gserviceaccount.com" \
       --role=roles/secretmanager.secretAccessor
   done
   ```

Os passos 2 e 3 cabem num comando só:

```bash
./scripts/ligar-google.sh <ID do cliente OAuth>
```

Ele pede a chave secreta no terminal, grava as duas no Secret Manager, libera o
acesso e implanta.

O `cloudbuild.yaml` detecta o segredo sozinho: sem ele, sobe com a senha
compartilhada; com ele, sobe com o Google. Não existe flag para alguém esquecer
de virar.

Para adicionar o connector na organização:

```bash
gcloud secrets versions access latest --secret=oauth-client-id
gcloud secrets versions access latest --secret=oauth-client-secret
```

No Claude: **Settings → Connectors → Add custom connector**, URL
`https://<serviço>.run.app/mcp`, e em **Advanced settings** cole o Client ID e o
Client Secret. Na primeira conexão o Claude abre a tela de autorização; digite a
senha de acesso (`OAUTH_SENHA`).

> **Teste que falta fazer e não dá para antecipar:** conectar com **duas contas
> diferentes** da organização e verificar se a autorização é herdada do
> connector (uma autorização vale para todo mundo) ou individual (cada pessoa
> digita a senha uma vez). Os dois cenários funcionam com este servidor; o que
> muda é quantas pessoas precisam conhecer a senha. Se for individual e você não
> quiser espalhar a senha, o caminho é trocar a checagem de senha em
> `src/auth.ts` por um IdP (Google Workspace da Enviagora via OIDC) — o resto do
> fluxo continua igual.

Um `redirect_uri` só é aceito se estiver em `OAUTH_REDIRECT_URIS` (por padrão os
callbacks de `claude.ai` e `claude.com`) ou for loopback, para o inspector.

---

## Rotacionar o token da Replicate

Fazer sempre que alguém com acesso sair da empresa, e de tempos em tempos por
higiene.

1. Em <https://replicate.com/account/api-tokens>, crie um token novo. **Não
   apague o antigo ainda.**
2. Grave a versão nova do segredo (o token vai por stdin; não aparece no
   histórico do shell):

   ```bash
   printf '%s' 'r8_o_token_novo' | \
     gcloud secrets versions add replicate-api-token --data-file=- --project=enviagora-mcp
   ```

   Se preferir não digitar o token na linha de comando:

   ```bash
   gcloud secrets versions add replicate-api-token --data-file=- --project=enviagora-mcp
   # cole o token, depois Ctrl-D
   ```

   > **Cuidado com `--data-file=-`.** Ele lê do stdin, então **rode esse comando
   > sozinho**, nunca colado junto com outros. Colado em bloco, ele engole as
   > linhas seguintes como se fossem o valor do segredo; e logo depois de um
   > `Ctrl-C` a sobra do buffer de paste vira um EOF imediato, criando o segredo
   > **sem versão nenhuma** — o serviço então sobe e morre no boot dizendo que a
   > variável está ausente. Na dúvida, use o console (Secret Manager → o segredo
   > → *Nova versão*), que não tem stdin para dar errado.

   Confira sempre que o valor entrou, sem imprimir o segredo:

   ```bash
   gcloud secrets versions access latest --secret=replicate-api-token | wc -c
   ```

3. O Cloud Run está preso em `:latest`, mas **não recarrega segredo sozinho** —
   force uma nova revisão:

   ```bash
   gcloud run services update imagegen --region=southamerica-east1 --project=enviagora-mcp
   ```

4. Confirme que o serviço subiu com o token novo gerando um rascunho pelo Claude
   (ou olhando o `/health`, que responde sem tocar na Replicate).
5. Só então **revogue o token antigo** na Replicate.
6. Desative a versão velha do segredo:

   ```bash
   gcloud secrets versions disable <NÚMERO_DA_VERSÃO_ANTIGA> \
     --secret=replicate-api-token --project=enviagora-mcp
   ```

Mesmo procedimento vale para `oauth-senha`, `oauth-client-secret` e
`oauth-assinatura`. Trocar `oauth-assinatura` invalida todos os tokens ativos e
obriga todo mundo a reconectar o connector — é exatamente o que se quer se
houver suspeita de vazamento.

---

## Segredos

Nenhuma credencial existe neste repositório, em nenhum commit do histórico.

- Produção: **Google Secret Manager**, montado como variável de ambiente pelo
  Cloud Run via `--set-secrets`. O Cloud Build nunca lê os valores.
- Local: `.env`, que está no `.gitignore`. O `.env.example` só tem nomes de
  variável, com os valores em branco.
- O `src/config/env.ts` recusa subir no Cloud Run sem autenticação configurada:
  o endpoint nunca fica aberto com a credencial da Replicate atrás dele.

Se algum dia um segredo entrar num commit, trocar o valor no Secret Manager e
revogá-lo na origem resolve de verdade; reescrever o histórico do Git, não.

---

## Uma armadilha do Cloud Run que custou caro

O endpoint de saúde é `/health`, **nunca** `/healthz`.

O Cloud Run reserva caminhos de URL terminados em `z`. O Google Frontend
intercepta esses pedidos e devolve um 404 **dele**, com a página de erro do
Google, antes de a requisição chegar no container. O sintoma engana: revisão
`Ready`, rotas `Ready`, `ingress=all`, probe de inicialização passando, o
processo logando que subiu — e mesmo assim toda requisição volta 404, sem
nenhum log de requisição, porque de fato nenhuma chegou.

Se um dia alguém renomear para `/healthz` seguindo o hábito do Kubernetes, o
serviço vai parecer quebrado sem nenhum erro que aponte a causa.

## Estrutura

```
src/
  index.ts            Express + transporte Streamable HTTP + rotas de OAuth
  tools.ts            Servidor MCP: gerar_imagem e estimar_custo
  auth.ts             OAuth 2.1 mínimo (metadados, /authorize, /token, guarda)
  replicate.ts        Cliente da Replicate HTTP API
  storage.ts          Cloud Storage + URL assinada (ou disco, na fase 1)
  budget.ts           Teto diário
  prompt.ts           Montagem do prompt final
  logging.ts          Log estruturado para o Cloud Logging
  config/
    models.ts         >>> mapeamento finalidade -> modelo <<<
    marca.ts          >>> diretrizes visuais da Enviagora <<<
    env.ts            Configuração e validação de boot
scripts/
  bootstrap-gcp.sh       Provisionamento do projeto (roda uma vez)
  subir.sh               Implanta, verifica e testa — um comando
  ligar-google.sh        Liga o login pelo Google Workspace e implanta
  token-leitura.sh       Token de diagnóstico, só leitura, expira em 1 hora
  teste-ponta-a-ponta.py OAuth + gerar_imagem contra o serviço em produção
cloudbuild.yaml          GitHub -> Cloud Build -> Cloud Run
```

---

## Variáveis de ambiente

| Variável | Padrão | Papel |
|---|---|---|
| `REPLICATE_API_TOKEN` | — | **Obrigatória.** Secret Manager. |
| `TETO_DIARIO_USD` | `10` | Teto de gasto do dia. |
| `FUSO_HORARIO` | `America/Sao_Paulo` | Quando o contador zera. |
| `GCS_BUCKET` | vazio | Vazio = grava em disco (fase 1). |
| `URL_ASSINADA_MINUTOS` | `10080` | Validade da URL assinada (7 dias, o máximo do V4). |
| `MAX_INLINE_MB` | `6` | Acima disso devolve só o link, não a imagem embutida. |
| `REPLICATE_TIMEOUT_MS` | `180000` | Timeout da geração. |
| `OAUTH_HABILITADO` | ligado no Cloud Run | Liga o OAuth. |
| `BASE_URL` | — | URL pública; entra nos metadados de OAuth. |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | — | O par colado no connector. |
| `OAUTH_SENHA` | — | Senha da tela de autorização (só sem Google). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | vazio | Liga o login pelo Google Workspace. |
| `DOMINIO_PERMITIDO` | `enviagora.com.br` | Único domínio aceito no login. |
| `OAUTH_ASSINATURA` | — | Chave HMAC que assina os tokens. |
| `OAUTH_REDIRECT_URIS` | callbacks do Claude | Allowlist de `redirect_uri`. |
| `MCP_STATIC_TOKEN` | vazio | Atalho de desenvolvimento. Vazio em produção. |

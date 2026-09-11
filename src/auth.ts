/**
 * Autenticação do endpoint MCP.
 *
 * A documentação atual de connectors custom do Claude oferece, em "Advanced
 * settings", um par **OAuth Client ID / Client Secret** — não há campo para
 * header estático de requisição. Então a opção 1 do briefing não existe hoje e
 * vale a opção 2: um OAuth 2.1 mínimo, de cliente único.
 *
 * Minimalismo importante: os tokens são **assinados, não armazenados**. O Cloud
 * Run roda com `min-instances=0` e recicla a instância; qualquer tabela em
 * memória obrigaria todo mundo a reautorizar a cada cold start. Aqui o token
 * carrega o próprio conteúdo com HMAC-SHA256 e é verificado sem estado.
 *
 * O que protege de verdade é a senha compartilhada digitada na tela de
 * autorização (`OAUTH_SENHA`, vinda do Secret Manager) somada ao PKCE.
 *
 * O atalho `MCP_STATIC_TOKEN` existe para o inspector do MCP e para `curl` no
 * desenvolvimento. Em produção ele fica vazio.
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config/env.js';
import { log } from './logging.js';

const VIDA_CODIGO_S = 300; // 5 min
const VIDA_ACCESS_S = 8 * 3600; // 8 h
const VIDA_REFRESH_S = 30 * 24 * 3600; // 30 dias
const VIDA_STATE_S = 900; // 15 min: o tempo de a pessoa escolher a conta no Google

type TipoToken = 'code' | 'access' | 'refresh' | 'state';

interface Carga {
  t: TipoToken;
  /** client_id a que o token pertence. */
  c: string;
  /** expiração (epoch em segundos). */
  e: number;
  /** nonce, para dois tokens iguais nunca colidirem. */
  n: string;
  /** em `code` e `state`: redirect_uri e code_challenge do PKCE. */
  r?: string;
  q?: string;
  /** em `state`: o `state` do cliente, para devolver intacto. */
  s?: string;
  /** e-mail de quem autorizou, quando o login é pelo Google Workspace. */
  u?: string;
}

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

function assinar(carga: Carga): string {
  const corpo = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  const mac = b64url(createHmac('sha256', config().oauthAssinatura).update(corpo).digest());
  return `${corpo}.${mac}`;
}

function comparar(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verificar(token: string, tipo: TipoToken): Carga | null {
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [corpo, mac] = partes as [string, string];
  const esperado = b64url(createHmac('sha256', config().oauthAssinatura).update(corpo).digest());
  if (!comparar(mac, esperado)) return null;

  let carga: Carga;
  try {
    carga = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as Carga;
  } catch {
    return null;
  }
  if (carga.t !== tipo) return null;
  if (carga.e < Math.floor(Date.now() / 1000)) return null;
  return carga;
}

function emitir(tipo: TipoToken, clientId: string, vidaS: number, extras: Partial<Carga> = {}): string {
  return assinar({
    t: tipo,
    c: clientId,
    e: Math.floor(Date.now() / 1000) + vidaS,
    n: randomBytes(9).toString('base64url'),
    ...extras,
  });
}

/** E-mail carregado pelo access token, quando o login foi pelo Google. */
export function donoDoToken(token: string): string | null {
  return verificar(token, 'access')?.u ?? null;
}

// ---------------------------------------------------------------------------
// Metadados (RFC 8414 e RFC 9728)
// ---------------------------------------------------------------------------

function base(): string {
  return config().baseUrl.replace(/\/$/, '');
}

export function metadadosRecursoProtegido() {
  return {
    resource: `${base()}/mcp`,
    authorization_servers: [base()],
    bearer_methods_supported: ['header'],
    scopes_supported: ['imagegen'],
  };
}

export function metadadosServidorAutorizacao() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/authorize`,
    token_endpoint: `${base()}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['imagegen'],
    // Sem `registration_endpoint` de propósito: o cliente é único e configurado
    // à mão em "Advanced settings" do connector. Registro dinâmico aberto
    // deixaria qualquer um pedir credencial a este servidor.
  };
}

// ---------------------------------------------------------------------------
// /authorize
// ---------------------------------------------------------------------------

function redirectPermitido(uri: string): boolean {
  const { oauthRedirectUris } = config();
  if (oauthRedirectUris.includes(uri)) return true;
  // Loopback é liberado para o inspector do MCP (RFC 8252 §7.3).
  try {
    const url = new URL(uri);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function escapar(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function paginaLogin(params: Record<string, string>, erro?: string): string {
  const ocultos = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapar(k)}" value="${escapar(v)}">`)
    .join('\n      ');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enviagora · autorizar geração de imagem</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#123336; color:#FAFAF5;
         font:400 15px/1.55 "Satoshi",-apple-system,"Segoe UI",Arial,sans-serif }
  main { width:min(92vw,380px); padding:8px }
  .olho { font-weight:700; font-size:12px; letter-spacing:.14em; text-transform:uppercase;
          color:#C4FF57; margin:0 0 10px }
  h1 { font-weight:500; font-size:24px; letter-spacing:.02em; line-height:1.15;
       text-transform:uppercase; margin:0 0 6px }
  p { margin:0 0 22px; color:#DEE3E0 }
  label { display:block; font-weight:700; font-size:12px; letter-spacing:.14em;
          text-transform:uppercase; margin-bottom:8px }
  input[type=password] { width:100%; box-sizing:border-box; padding:12px 14px;
          border:1px solid #B0C2BF; border-radius:8px; background:#FAFAF5; color:#123336;
          font-size:16px }
  button { width:100%; margin-top:16px; padding:13px; border:0; border-radius:8px;
           background:#C4FF57; color:#123336; font-weight:700; font-size:13px;
           letter-spacing:.14em; text-transform:uppercase; cursor:pointer }
  .erro { border-left:2px solid #C4FF57; padding:8px 0 8px 12px; margin:0 0 18px;
          color:#FAFAF5 }
</style></head>
<body><main>
  <p class="olho">Enviagora</p>
  <h1>Autorizar geração<br>de imagem</h1>
  <p>Conecte o Claude ao servidor de imagens da Enviagora.</p>
  ${erro ? `<p class="erro">${escapar(erro)}</p>` : ''}
  <form method="post" action="/authorize">
      ${ocultos}
    <label for="senha">Senha de acesso</label>
    <input id="senha" name="senha" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Autorizar</button>
  </form>
</main></body></html>`;
}

/** Mesmo visual da tela de login, para recusa e mensagens de erro. */
function paginaAviso(titulo: string, mensagem: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enviagora · ${escapar(titulo)}</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#123336; color:#FAFAF5;
         font:400 15px/1.55 "Satoshi",-apple-system,"Segoe UI",Arial,sans-serif }
  main { width:min(92vw,420px); padding:8px }
  .olho { font-weight:700; font-size:12px; letter-spacing:.14em; text-transform:uppercase;
          color:#C4FF57; margin:0 0 10px }
  h1 { font-weight:500; font-size:24px; letter-spacing:.02em; line-height:1.15;
       text-transform:uppercase; margin:0 0 14px }
  p { margin:0; color:#DEE3E0 }
</style></head>
<body><main>
  <p class="olho">Enviagora</p>
  <h1>${escapar(titulo)}</h1>
  <p>${mensagem}</p>
</main></body></html>`;
}

const CAMPOS_REPASSADOS = [
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'resource',
] as const;

function extrair(origem: Record<string, unknown>): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const campo of CAMPOS_REPASSADOS) {
    const valor = origem[campo];
    if (typeof valor === 'string') saida[campo] = valor;
  }
  return saida;
}

/** Erros que não podem virar redirect (redirect_uri inválido) viram HTML. */
function recusarAuthorize(res: Response, motivo: string): void {
  res.status(400).type('text/plain; charset=utf-8').send(`Pedido de autorização inválido: ${motivo}`);
}

export function authorizeGet(req: Request, res: Response): void {
  const params = extrair(req.query as Record<string, unknown>);
  const problema = validarPedido(params, String((req.query as Record<string, unknown>).response_type ?? ''));
  if (problema) {
    recusarAuthorize(res, problema);
    return;
  }

  if (config().googleClientId) {
    res.redirect(302, urlDoGoogle(params));
    return;
  }

  res.status(200).type('text/html; charset=utf-8').send(paginaLogin(params));
}

// ---------------------------------------------------------------------------
// Login pelo Google Workspace
// ---------------------------------------------------------------------------

const GOOGLE_AUTORIZACAO = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function urlDoGoogleCallback(): string {
  return `${base()}/auth/google/callback`;
}

/**
 * O pedido original do Claude viaja assinado dentro do `state`. Assim não
 * guardamos nada em memória — o Cloud Run recicla a instância a qualquer
 * momento, e uma tabela de pedidos pendentes perderia quem está no meio do
 * login.
 */
function urlDoGoogle(params: Record<string, string>): string {
  const estado = assinar({
    t: 'state',
    c: params.client_id!,
    e: Math.floor(Date.now() / 1000) + VIDA_STATE_S,
    n: randomBytes(9).toString('base64url'),
    r: params.redirect_uri!,
    q: params.code_challenge!,
    ...(params.state ? { s: params.state } : {}),
  });

  const url = new URL(GOOGLE_AUTORIZACAO);
  url.searchParams.set('client_id', config().googleClientId);
  url.searchParams.set('redirect_uri', urlDoGoogleCallback());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', estado);
  url.searchParams.set('prompt', 'select_account');
  // Dica de domínio: o Google já abre na conta corporativa. Não é garantia de
  // segurança — a checagem de verdade é a do claim `hd`, feita no callback.
  url.searchParams.set('hd', config().dominioPermitido);
  return url.toString();
}

interface IdentidadeGoogle {
  email: string;
  dominio: string;
}

/**
 * Troca o código pelo id_token e extrai a identidade.
 *
 * A assinatura do id_token não é verificada de propósito: ele vem direto do
 * endpoint do Google, por TLS, numa chamada autenticada com o nosso client
 * secret. É a exceção que a própria documentação do Google prevê, e evita
 * carregar JWKS e rotação de chave para nada.
 */
async function identidadeDoGoogle(code: string): Promise<IdentidadeGoogle> {
  const cfg = config();
  const resposta = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.googleClientId,
      client_secret: cfg.googleClientSecret,
      redirect_uri: urlDoGoogleCallback(),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resposta.ok) {
    const detalhe = await resposta.text().catch(() => '');
    throw new Error(`o Google recusou a troca do código (HTTP ${resposta.status}): ${detalhe.slice(0, 200)}`);
  }

  const { id_token: idToken } = (await resposta.json()) as { id_token?: string };
  if (!idToken) throw new Error('o Google não devolveu id_token');

  const corpo = idToken.split('.')[1];
  if (!corpo) throw new Error('id_token malformado');
  const claims = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) as {
    aud?: string;
    email?: string;
    email_verified?: boolean | string;
    hd?: string;
    exp?: number;
  };

  if (claims.aud !== cfg.googleClientId) throw new Error('id_token emitido para outro aplicativo');
  if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw new Error('id_token expirado');
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('a conta do Google não tem e-mail verificado');
  }
  if (!claims.email) throw new Error('id_token sem e-mail');

  return { email: claims.email, dominio: claims.hd ?? claims.email.split('@')[1] ?? '' };
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const estadoBruto = typeof query.state === 'string' ? query.state : '';
  const carga = verificar(estadoBruto, 'state');

  if (!carga?.r) {
    recusarAuthorize(res, 'o pedido de login expirou ou foi adulterado. Comece de novo pelo Claude.');
    return;
  }

  const devolver = (extras: Record<string, string>) => {
    const destino = new URL(carga.r!);
    for (const [k, v] of Object.entries(extras)) destino.searchParams.set(k, v);
    if (carga.s) destino.searchParams.set('state', carga.s);
    res.redirect(302, destino.toString());
  };

  if (typeof query.error === 'string') {
    log.warn('login pelo Google cancelado', { erro: query.error });
    devolver({ error: 'access_denied', error_description: 'O login pelo Google foi cancelado.' });
    return;
  }

  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) {
    devolver({ error: 'invalid_request', error_description: 'O Google não devolveu código.' });
    return;
  }

  let identidade: IdentidadeGoogle;
  try {
    identidade = await identidadeDoGoogle(code);
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    log.error('falha ao validar a identidade no Google', { erro: motivo });
    devolver({ error: 'server_error', error_description: 'Não foi possível validar sua conta do Google.' });
    return;
  }

  const permitido = config().dominioPermitido;
  if (identidade.dominio.toLowerCase() !== permitido.toLowerCase()) {
    log.warn('login recusado: domínio fora do permitido', {
      dominio: identidade.dominio,
      permitido,
    });
    res.status(403).type('text/html; charset=utf-8').send(
      paginaAviso(
        'Conta não autorizada',
        `Esta ferramenta é restrita a contas @${escapar(permitido)}. ` +
          `Você entrou com uma conta de outro domínio. Volte ao Claude e conecte de novo, ` +
          `escolhendo sua conta da empresa.`,
      ),
    );
    return;
  }

  log.info('autorização concedida pelo Google', { email: identidade.email });

  devolver({
    code: emitir('code', carga.c, VIDA_CODIGO_S, {
      r: carga.r,
      q: carga.q,
      u: identidade.email,
    }),
  });
}

function validarPedido(params: Record<string, string>, responseType: string): string | null {
  const { oauthClientId } = config();
  if (responseType !== 'code') return 'só `response_type=code` é suportado.';
  if (params.client_id !== oauthClientId) return 'client_id desconhecido.';
  if (!params.redirect_uri) return 'redirect_uri ausente.';
  if (!redirectPermitido(params.redirect_uri)) {
    return 'redirect_uri não está na lista permitida (OAUTH_REDIRECT_URIS).';
  }
  if (!params.code_challenge) return 'PKCE é obrigatório: falta code_challenge.';
  if ((params.code_challenge_method ?? 'plain') !== 'S256') return 'PKCE precisa ser S256.';
  return null;
}

export function authorizePost(req: Request, res: Response): void {
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  const params = extrair(corpo);
  const problema = validarPedido(params, 'code');
  if (problema) {
    recusarAuthorize(res, problema);
    return;
  }

  const senha = typeof corpo.senha === 'string' ? corpo.senha : '';
  if (!comparar(senha, config().oauthSenha)) {
    log.warn('senha de autorização recusada', { ip: req.ip });
    res.status(401).type('text/html; charset=utf-8').send(paginaLogin(params, 'Senha incorreta. Tente de novo.'));
    return;
  }

  const code = emitir('code', params.client_id!, VIDA_CODIGO_S, {
    r: params.redirect_uri!,
    q: params.code_challenge!,
  });

  const destino = new URL(params.redirect_uri!);
  destino.searchParams.set('code', code);
  if (params.state) destino.searchParams.set('state', params.state);

  log.info('autorização concedida', { client_id: params.client_id });
  res.redirect(302, destino.toString());
}

// ---------------------------------------------------------------------------
// /token
// ---------------------------------------------------------------------------

function autenticarCliente(req: Request): boolean {
  const { oauthClientId, oauthClientSecret } = config();
  const corpo = (req.body ?? {}) as Record<string, unknown>;

  const cabecalho = req.header('authorization');
  if (cabecalho?.toLowerCase().startsWith('basic ')) {
    const [id, segredo] = Buffer.from(cabecalho.slice(6), 'base64').toString('utf8').split(':');
    return comparar(decodeURIComponent(id ?? ''), oauthClientId) &&
      comparar(decodeURIComponent(segredo ?? ''), oauthClientSecret);
  }

  const id = typeof corpo.client_id === 'string' ? corpo.client_id : '';
  const segredo = typeof corpo.client_secret === 'string' ? corpo.client_secret : '';
  return comparar(id, oauthClientId) && comparar(segredo, oauthClientSecret);
}

function erroToken(res: Response, status: number, code: string, descricao: string): void {
  res.status(status).json({ error: code, error_description: descricao });
}

export function tokenPost(req: Request, res: Response): void {
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  const grant = typeof corpo.grant_type === 'string' ? corpo.grant_type : '';

  if (!autenticarCliente(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="enviagora-imagegen"');
    erroToken(res, 401, 'invalid_client', 'Client ID ou Client Secret inválidos.');
    return;
  }

  const clientId = config().oauthClientId;

  if (grant === 'authorization_code') {
    const code = typeof corpo.code === 'string' ? corpo.code : '';
    const verifier = typeof corpo.code_verifier === 'string' ? corpo.code_verifier : '';
    const redirect = typeof corpo.redirect_uri === 'string' ? corpo.redirect_uri : '';

    const carga = verificar(code, 'code');
    if (!carga) {
      erroToken(res, 400, 'invalid_grant', 'Código de autorização inválido ou expirado.');
      return;
    }
    if (carga.r !== redirect) {
      erroToken(res, 400, 'invalid_grant', 'redirect_uri não confere com o do pedido de autorização.');
      return;
    }
    const desafio = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    if (!carga.q || !comparar(desafio, carga.q)) {
      erroToken(res, 400, 'invalid_grant', 'Verificação PKCE falhou.');
      return;
    }

    // Quem autorizou segue junto no token, e é o que permite atribuir o custo
    // de cada geração a uma pessoa em vez de só ao serviço.
    const dono = carga.u ? { u: carga.u } : {};
    res.json({
      access_token: emitir('access', clientId, VIDA_ACCESS_S, dono),
      token_type: 'Bearer',
      expires_in: VIDA_ACCESS_S,
      refresh_token: emitir('refresh', clientId, VIDA_REFRESH_S, dono),
      scope: 'imagegen',
    });
    return;
  }

  if (grant === 'refresh_token') {
    const bruto = typeof corpo.refresh_token === 'string' ? corpo.refresh_token : '';
    const anterior = verificar(bruto, 'refresh');
    if (!anterior) {
      erroToken(res, 400, 'invalid_grant', 'Refresh token inválido ou expirado. Reconecte o connector.');
      return;
    }
    const dono = anterior.u ? { u: anterior.u } : {};
    res.json({
      access_token: emitir('access', clientId, VIDA_ACCESS_S, dono),
      token_type: 'Bearer',
      expires_in: VIDA_ACCESS_S,
      refresh_token: emitir('refresh', clientId, VIDA_REFRESH_S, dono),
      scope: 'imagegen',
    });
    return;
  }

  erroToken(res, 400, 'unsupported_grant_type', `grant_type "${grant}" não é suportado.`);
}

// ---------------------------------------------------------------------------
// Guarda do /mcp
// ---------------------------------------------------------------------------

export function exigirAutenticacao(req: Request, res: Response, next: NextFunction): void {
  const { oauthHabilitado, tokenEstatico } = config();

  if (!oauthHabilitado && !tokenEstatico) {
    next(); // Só acontece rodando local; o boot recusa isso no Cloud Run.
    return;
  }

  const cabecalho = req.header('authorization') ?? '';
  const bearer = cabecalho.toLowerCase().startsWith('bearer ') ? cabecalho.slice(7).trim() : '';

  if (tokenEstatico && bearer && comparar(bearer, tokenEstatico)) {
    next();
    return;
  }

  if (oauthHabilitado && bearer) {
    const carga = verificar(bearer, 'access');
    if (carga) {
      // O SDK do MCP repassa isto ao callback da ferramenta, que usa o e-mail
      // para atribuir o custo da geração a uma pessoa.
      (req as Request & { auth?: unknown }).auth = {
        token: bearer,
        clientId: carga.c,
        scopes: ['imagegen'],
        expiresAt: carga.e,
        extra: carga.u ? { email: carga.u } : {},
      };
      next();
      return;
    }
  }

  // RFC 9728: o 401 diz ao cliente onde descobrir como se autenticar.
  if (oauthHabilitado) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="enviagora-imagegen", resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
    );
  }
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Não autorizado. Reconecte o connector da Enviagora.' },
    id: null,
  });
}

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

type TipoToken = 'code' | 'access' | 'refresh';

interface Carga {
  t: TipoToken;
  /** client_id a que o token pertence. */
  c: string;
  /** expiração (epoch em segundos). */
  e: number;
  /** nonce, para dois tokens iguais nunca colidirem. */
  n: string;
  /** só em `code`: redirect_uri e code_challenge do PKCE. */
  r?: string;
  q?: string;
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
  res.status(200).type('text/html; charset=utf-8').send(paginaLogin(params));
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

    res.json({
      access_token: emitir('access', clientId, VIDA_ACCESS_S),
      token_type: 'Bearer',
      expires_in: VIDA_ACCESS_S,
      refresh_token: emitir('refresh', clientId, VIDA_REFRESH_S),
      scope: 'imagegen',
    });
    return;
  }

  if (grant === 'refresh_token') {
    const bruto = typeof corpo.refresh_token === 'string' ? corpo.refresh_token : '';
    if (!verificar(bruto, 'refresh')) {
      erroToken(res, 400, 'invalid_grant', 'Refresh token inválido ou expirado. Reconecte o connector.');
      return;
    }
    res.json({
      access_token: emitir('access', clientId, VIDA_ACCESS_S),
      token_type: 'Bearer',
      expires_in: VIDA_ACCESS_S,
      refresh_token: emitir('refresh', clientId, VIDA_REFRESH_S),
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

  if (oauthHabilitado && bearer && verificar(bearer, 'access')) {
    next();
    return;
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

/**
 * Leitura e validação da configuração. Nada aqui tem valor-padrão de segredo:
 * se um segredo obrigatório faltar, o processo morre no boot, não na primeira
 * requisição.
 */

function obrigatoria(nome: string): string {
  const valor = process.env[nome]?.trim();
  if (!valor) {
    throw new Error(
      `Variável de ambiente obrigatória ausente: ${nome}. ` +
        `Em produção ela vem do Secret Manager; local, do seu .env (não commitado).`,
    );
  }
  return valor;
}

function opcional(nome: string, padrao: string): string {
  const valor = process.env[nome]?.trim();
  return valor && valor.length > 0 ? valor : padrao;
}

function numero(nome: string, padrao: number): number {
  const bruto = process.env[nome]?.trim();
  if (!bruto) return padrao;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Variável ${nome} deve ser um número >= 0. Recebido: ${bruto}`);
  }
  return n;
}

function booleana(nome: string, padrao: boolean): boolean {
  const bruto = process.env[nome]?.trim().toLowerCase();
  if (!bruto) return padrao;
  return bruto === '1' || bruto === 'true' || bruto === 'yes' || bruto === 'sim';
}

export interface Config {
  porta: number;
  ambiente: 'local' | 'cloud-run';
  nomeServico: string;

  replicateToken: string;
  replicateTimeoutMs: number;

  /** Teto de gasto diário em USD. Ao atingir, `gerar_imagem` recusa. */
  tetoDiarioUsd: number;
  /** Fuso usado para decidir quando o contador diário zera. */
  fusoHorario: string;

  /** Bucket do Cloud Storage. Vazio = fase 1 (salva em disco local). */
  bucket: string;
  /** Validade da URL assinada, em minutos. */
  urlAssinadaMinutos: number;
  /** Diretório usado quando não há bucket configurado. */
  diretorioLocal: string;

  /** Acima disso a imagem não volta embutida no MCP, só a URL. */
  maxInlineMb: number;

  /** Base pública do serviço, usada nos metadados de OAuth. */
  baseUrl: string;
  /** Atalho de header estático (inspector / curl). Vazio = desligado. */
  tokenEstatico: string;
  oauthHabilitado: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  /** Senha compartilhada que a pessoa digita na tela de autorização. */
  oauthSenha: string;
  /** Segredo HMAC que assina os tokens. Trocar = derrubar todas as sessões. */
  oauthAssinatura: string;
  oauthRedirectUris: string[];
}

let cache: Config | null = null;

export function config(): Config {
  if (cache) return cache;

  const emCloudRun = Boolean(process.env.K_SERVICE);

  cache = {
    porta: numero('PORT', 8080),
    ambiente: emCloudRun ? 'cloud-run' : 'local',
    nomeServico: opcional('K_SERVICE', 'enviagora-mcp-imagegen'),

    replicateToken: obrigatoria('REPLICATE_API_TOKEN'),
    replicateTimeoutMs: numero('REPLICATE_TIMEOUT_MS', 180_000),

    tetoDiarioUsd: numero('TETO_DIARIO_USD', 10),
    fusoHorario: opcional('FUSO_HORARIO', 'America/Sao_Paulo'),

    bucket: opcional('GCS_BUCKET', ''),
    urlAssinadaMinutos: numero('URL_ASSINADA_MINUTOS', 60),
    diretorioLocal: opcional('DIRETORIO_LOCAL', './.imagens-locais'),

    maxInlineMb: numero('MAX_INLINE_MB', 6),

    baseUrl: opcional('BASE_URL', ''),
    tokenEstatico: opcional('MCP_STATIC_TOKEN', ''),
    oauthHabilitado: booleana('OAUTH_HABILITADO', emCloudRun),
    oauthClientId: opcional('OAUTH_CLIENT_ID', ''),
    oauthClientSecret: opcional('OAUTH_CLIENT_SECRET', ''),
    oauthSenha: opcional('OAUTH_SENHA', ''),
    oauthAssinatura: opcional('OAUTH_ASSINATURA', ''),
    oauthRedirectUris: opcional(
      'OAUTH_REDIRECT_URIS',
      'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback',
    )
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
  };

  if (cache.oauthHabilitado) {
    const faltando = (
      [
        ['OAUTH_CLIENT_ID', cache.oauthClientId],
        ['OAUTH_CLIENT_SECRET', cache.oauthClientSecret],
        ['OAUTH_SENHA', cache.oauthSenha],
        ['OAUTH_ASSINATURA', cache.oauthAssinatura],
        ['BASE_URL', cache.baseUrl],
      ] as const
    )
      .filter(([, valor]) => !valor)
      .map(([nome]) => nome);

    if (faltando.length > 0) {
      throw new Error(
        `OAUTH_HABILITADO está ligado mas faltam: ${faltando.join(', ')}. ` +
          `Sem isso o endpoint /mcp ficaria aberto na internet com a credencial da Replicate atrás dele.`,
      );
    }
  } else if (!cache.tokenEstatico) {
    // Ninguém protegendo /mcp. Só toleramos isso rodando local.
    if (emCloudRun) {
      throw new Error(
        'Nenhuma autenticação configurada (nem OAUTH_HABILITADO, nem MCP_STATIC_TOKEN) e o ' +
          'serviço está no Cloud Run. Recusando subir: o endpoint ficaria aberto.',
      );
    }
  }

  return cache;
}

/** Só para teste: descarta o cache depois de mexer em process.env. */
export function resetConfig(): void {
  cache = null;
}

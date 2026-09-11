/**
 * Cliente mínimo da Replicate HTTP API.
 *
 * Usa o endpoint oficial de modelo (`POST /v1/models/{owner}/{name}/predictions`)
 * com `Prefer: wait`, que segura a conexão até a prediction terminar e dispensa
 * polling na maioria dos casos. Se mesmo assim voltar em `starting`/`processing`,
 * cai no polling até o timeout.
 */

import { config } from './config/env.js';
import { log } from './logging.js';
import type { EntradaReplicate } from './config/models.js';

const BASE = 'https://api.replicate.com/v1';

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
  metrics?: { predict_time?: number };
}

export class ReplicateError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detalhe?: string,
  ) {
    super(message);
    this.name = 'ReplicateError';
  }
}

function cabecalhos(): Record<string, string> {
  return {
    Authorization: `Bearer ${config().replicateToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'enviagora-mcp-imagegen/1.0',
  };
}

/** A Replicate devolve a saída como string, array de strings ou objeto com URL. */
function primeiraUrl(output: unknown): string | null {
  if (typeof output === 'string') return output.startsWith('http') ? output : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = primeiraUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    for (const chave of ['url', 'image', 'output']) {
      const url = primeiraUrl(obj[chave]);
      if (url) return url;
    }
  }
  return null;
}

async function esperar(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function lerErro(resposta: Response): Promise<string> {
  const texto = await resposta.text().catch(() => '');
  try {
    const json = JSON.parse(texto) as { detail?: string; title?: string };
    return json.detail ?? json.title ?? texto.slice(0, 400);
  } catch {
    return texto.slice(0, 400);
  }
}

/** Traduz o erro cru da Replicate em algo acionável para quem está no Claude. */
function traduzirFalha(status: number, detalhe: string): string {
  if (status === 401 || status === 403) {
    return 'A credencial da Replicate foi recusada. O token precisa ser rotacionado no Secret Manager (veja o README).';
  }
  if (status === 402) {
    return 'A conta da Replicate está sem saldo. Alguém precisa recarregar em replicate.com/account/billing.';
  }
  if (status === 422) {
    return `A Replicate recusou os parâmetros da geração: ${detalhe}`;
  }
  if (status === 429) {
    return 'A Replicate está limitando a taxa de requisições. Tente de novo em alguns segundos.';
  }
  if (status >= 500) {
    return 'A Replicate está com instabilidade no momento. Tente de novo em alguns minutos.';
  }
  return `A Replicate respondeu ${status}: ${detalhe}`;
}

export interface ResultadoPrediction {
  urlImagem: string;
  predictionId: string;
  segundos: number | null;
}

export async function gerar(slug: string, input: EntradaReplicate): Promise<ResultadoPrediction> {
  const { replicateTimeoutMs } = config();
  const limite = AbortSignal.timeout(replicateTimeoutMs);

  let resposta: Response;
  try {
    resposta = await fetch(`${BASE}/models/${slug}/predictions`, {
      method: 'POST',
      headers: { ...cabecalhos(), Prefer: 'wait' },
      body: JSON.stringify({ input }),
      signal: limite,
    });
  } catch (erro) {
    const causa = erro instanceof Error ? erro.message : String(erro);
    throw new ReplicateError(
      `Não foi possível falar com a Replicate (${causa}). Verifique a conectividade de saída do serviço.`,
    );
  }

  if (!resposta.ok) {
    const detalhe = await lerErro(resposta);
    log.error('replicate recusou a prediction', { status: resposta.status, detalhe, slug });
    throw new ReplicateError(traduzirFalha(resposta.status, detalhe), resposta.status, detalhe);
  }

  let prediction = (await resposta.json()) as Prediction;

  // `Prefer: wait` cobre a maioria dos casos; 4K pode estourar a janela.
  const prazo = Date.now() + replicateTimeoutMs;
  while (prediction.status === 'starting' || prediction.status === 'processing') {
    if (Date.now() > prazo) {
      throw new ReplicateError(
        `A geração passou de ${Math.round(replicateTimeoutMs / 1000)}s e foi abandonada. ` +
          `A prediction ${prediction.id} pode ainda concluir na Replicate e ser cobrada.`,
      );
    }
    await esperar(1500);
    const url = prediction.urls?.get ?? `${BASE}/predictions/${prediction.id}`;
    const consulta = await fetch(url, { headers: cabecalhos(), signal: AbortSignal.timeout(30_000) });
    if (!consulta.ok) {
      const detalhe = await lerErro(consulta);
      throw new ReplicateError(traduzirFalha(consulta.status, detalhe), consulta.status, detalhe);
    }
    prediction = (await consulta.json()) as Prediction;
  }

  if (prediction.status !== 'succeeded') {
    const detalhe = prediction.error ?? prediction.status;
    throw new ReplicateError(
      `A geração falhou na Replicate: ${detalhe}. ` +
        `Prompts recusados costumam bater no filtro de conteúdo do modelo — reformule e tente de novo.`,
      undefined,
      String(detalhe),
    );
  }

  const urlImagem = primeiraUrl(prediction.output);
  if (!urlImagem) {
    throw new ReplicateError(
      `A Replicate concluiu mas não devolveu URL de imagem (prediction ${prediction.id}).`,
    );
  }

  return {
    urlImagem,
    predictionId: prediction.id,
    segundos: prediction.metrics?.predict_time ?? null,
  };
}

/** Baixa o binário da imagem gerada. A URL da Replicate é efêmera (≈1h). */
export async function baixar(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const resposta = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resposta.ok) {
    throw new ReplicateError(`Não foi possível baixar a imagem gerada (HTTP ${resposta.status}).`);
  }
  const bytes = Buffer.from(await resposta.arrayBuffer());
  const contentType = resposta.headers.get('content-type') ?? 'image/png';
  return { bytes, contentType };
}

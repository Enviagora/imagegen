/**
 * Mapeamento finalidade -> modelo da Replicate.
 *
 * >>> PARA TROCAR O MODELO DE UMA FINALIDADE, ALTERE UMA LINHA EM
 * >>> `MODELO_POR_FINALIDADE` E NADA MAIS. <<<
 *
 * Preços e schemas confirmados diretamente nas páginas dos modelos na Replicate
 * em 2026-09-11. Replicate cobra por imagem de saída nestes três modelos
 * (metric `image_output_count`), não por segundo de GPU.
 */

export const FINALIDADES = ['rascunho', 'final', 'impressao'] as const;
export type Finalidade = (typeof FINALIDADES)[number];

export const FORMATOS = ['quadrado', 'vertical', 'horizontal', 'story'] as const;
export type Formato = (typeof FORMATOS)[number];

// ---------------------------------------------------------------------------
// A ÚNICA COISA QUE SE MEXE PARA TROCAR DE MODELO
// ---------------------------------------------------------------------------
export const MODELO_POR_FINALIDADE: Record<Finalidade, ModeloSlug> = {
  rascunho: 'black-forest-labs/flux-schnell',
  final: 'bytedance/seedream-4',
  impressao: 'google/nano-banana-pro',
};
// ---------------------------------------------------------------------------

export type ModeloSlug =
  | 'black-forest-labs/flux-schnell'
  | 'bytedance/seedream-4'
  | 'google/nano-banana-pro'
  | 'google/nano-banana'
  | 'black-forest-labs/flux-dev'
  | 'black-forest-labs/flux-1.1-pro'
  | 'black-forest-labs/flux-1.1-pro-ultra'
  | 'ideogram-ai/ideogram-v3-quality'
  | 'recraft-ai/recraft-v3'
  | 'qwen/qwen-image';

export interface EntradaReplicate {
  [chave: string]: unknown;
}

export interface Modelo {
  /** Slug `owner/name` usado no endpoint oficial de predictions da Replicate. */
  readonly slug: ModeloSlug;
  /** Rótulo curto mostrado ao usuário final no retorno da ferramenta. */
  readonly rotulo: string;
  /** Custo em USD por imagem de saída, conforme a página do modelo. */
  readonly custoUsdPorImagem: number;
  /** O modelo aceita imagem de referência? */
  readonly aceitaReferencia: boolean;
  /** Resolução nominal, para o README e para a mensagem de retorno. */
  readonly resolucao: string;
  /** Monta o corpo `input` da prediction. */
  buildInput(args: { prompt: string; formato: Formato; referencia?: string }): EntradaReplicate;
}

/**
 * Cada modelo suporta um conjunto diferente de aspect ratios. O adaptador
 * escolhe o valor suportado mais próximo do formato pedido pelo usuário.
 */
const CATALOGO: Record<ModeloSlug, Modelo> = {
  // ~US$ 0,003/img — "333 images for $1". Rápido (poucos segundos), sem referência.
  'black-forest-labs/flux-schnell': {
    slug: 'black-forest-labs/flux-schnell',
    rotulo: 'FLUX schnell',
    custoUsdPorImagem: 0.003,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      num_outputs: 1,
      megapixels: '1',
      output_format: 'png',
      output_quality: 90,
      go_fast: true,
    }),
  },

  // US$ 0,03/img em qualquer resolução (1K/2K/4K). Aceita até 10 imagens de referência.
  'bytedance/seedream-4': {
    slug: 'bytedance/seedream-4',
    rotulo: 'Seedream 4',
    custoUsdPorImagem: 0.03,
    aceitaReferencia: true,
    resolucao: '2K (2048 px)',
    buildInput: ({ prompt, formato, referencia }) => ({
      prompt,
      size: '2K',
      // Seedream 4 não tem 4:5 no enum; 3:4 é o vertical mais próximo.
      aspect_ratio: { quadrado: '1:1', vertical: '3:4', horizontal: '16:9', story: '9:16' }[formato],
      sequential_image_generation: 'disabled',
      max_images: 1,
      ...(referencia ? { image_input: [referencia] } : {}),
    }),
  },

  // US$ 0,15/img em 1K e 2K; US$ 0,30/img em 4K. Melhor renderização de texto.
  'google/nano-banana-pro': {
    slug: 'google/nano-banana-pro',
    rotulo: 'Nano Banana Pro (4K)',
    custoUsdPorImagem: 0.3,
    aceitaReferencia: true,
    resolucao: '4K (4096 px)',
    buildInput: ({ prompt, formato, referencia }) => ({
      prompt,
      resolution: '4K',
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      output_format: 'png',
      // Sem fallback silencioso: se o modelo estiver sem capacidade queremos o
      // erro, não uma cobrança por um modelo que não foi o escolhido.
      allow_fallback_model: false,
    }),
  },

  // --- Alternativas já mapeadas, prontas para entrar em MODELO_POR_FINALIDADE ---

  // US$ 0,03/img se trocar `impressao` para 4K barato (mesmo modelo do tier final).
  'google/nano-banana': {
    slug: 'google/nano-banana',
    rotulo: 'Nano Banana',
    custoUsdPorImagem: 0.039,
    aceitaReferencia: true,
    resolucao: '1 MP',
    buildInput: ({ prompt, formato, referencia }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      output_format: 'png',
      ...(referencia ? { image_input: [referencia] } : {}),
    }),
  },

  'black-forest-labs/flux-dev': {
    slug: 'black-forest-labs/flux-dev',
    rotulo: 'FLUX dev',
    custoUsdPorImagem: 0.025,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      num_outputs: 1,
      output_format: 'png',
    }),
  },

  'black-forest-labs/flux-1.1-pro': {
    slug: 'black-forest-labs/flux-1.1-pro',
    rotulo: 'FLUX 1.1 pro',
    custoUsdPorImagem: 0.04,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      output_format: 'png',
    }),
  },

  'black-forest-labs/flux-1.1-pro-ultra': {
    slug: 'black-forest-labs/flux-1.1-pro-ultra',
    rotulo: 'FLUX 1.1 pro ultra',
    custoUsdPorImagem: 0.06,
    aceitaReferencia: false,
    resolucao: '4 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      output_format: 'png',
    }),
  },

  'ideogram-ai/ideogram-v3-quality': {
    slug: 'ideogram-ai/ideogram-v3-quality',
    rotulo: 'Ideogram v3 quality',
    custoUsdPorImagem: 0.09,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
    }),
  },

  'recraft-ai/recraft-v3': {
    slug: 'recraft-ai/recraft-v3',
    rotulo: 'Recraft v3',
    custoUsdPorImagem: 0.04,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      size: { quadrado: '1024x1024', vertical: '1024x1280', horizontal: '1820x1024', story: '1024x1820' }[formato],
    }),
  },

  'qwen/qwen-image': {
    slug: 'qwen/qwen-image',
    rotulo: 'Qwen Image',
    custoUsdPorImagem: 0.025,
    aceitaReferencia: false,
    resolucao: '~1 MP',
    buildInput: ({ prompt, formato }) => ({
      prompt,
      aspect_ratio: { quadrado: '1:1', vertical: '4:5', horizontal: '16:9', story: '9:16' }[formato],
      output_format: 'png',
    }),
  },
};

export function modeloPara(finalidade: Finalidade): Modelo {
  const slug = MODELO_POR_FINALIDADE[finalidade];
  const modelo = CATALOGO[slug];
  if (!modelo) {
    throw new Error(
      `Slug "${slug}" mapeado para a finalidade "${finalidade}" não existe no catálogo de src/config/models.ts.`,
    );
  }
  return modelo;
}

export function custoEstimadoUsd(finalidade: Finalidade, quantidade = 1): number {
  return Number((modeloPara(finalidade).custoUsdPorImagem * quantidade).toFixed(4));
}

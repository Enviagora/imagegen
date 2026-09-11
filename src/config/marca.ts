/**
 * Camada de marca — diretrizes visuais da Enviagora injetadas no prompt quando
 * `marca: true`.
 *
 * Fonte: sistema visual "Autoridade Técnica" (redesign 2026), skill
 * `branding-enviagora`. Se o manual mudar, este arquivo é o único lugar a
 * alterar — não espalhe regra de marca pelo resto do código.
 *
 * Regra importante: o modelo de imagem NÃO desenha o logotipo. O wordmark
 * ENVIAGORA e a seta são arquivos vetoriais oficiais; qualquer coisa que uma IA
 * generativa produza no lugar deles é marca errada. O prompt pede espaço
 * negativo limpo para o logo ser composto depois, no arquivo correto.
 */

export const PALETA = {
  verdeProfundo: '#123336',
  verdeNeon: '#C4FF57',
  creme: '#FAFAF5',
  cinzaNevoa: '#DEE3E0',
  eucalipto: '#B0C2BF',
} as const;

/** Bloco anexado ao prompt do usuário quando `marca: true`. */
export const DIRETRIZES_DE_MARCA = [
  'Brand art direction — Enviagora "Autoridade Técnica" visual system. Follow strictly:',
  '',
  `COLOR: use only this palette — deep green ${PALETA.verdeProfundo} (primary surfaces and body),`,
  `neon lime ${PALETA.verdeNeon} (single accent), cream ${PALETA.creme} (light background),`,
  `mist grey ${PALETA.cinzaNevoa} (secondary surfaces), eucalyptus ${PALETA.eucalipto} (calm blocks).`,
  'Exactly ONE neon accent in the whole image. Neon is a fill, a block or a large numeral on a dark',
  'background — never small text and never any text on a light background. No other colors,',
  'no gradients, no glow, no pastel, no purple, no beige.',
  '',
  'COMPOSITION: technical, angular, geometric. Modular grid of flat color blocks in quadrants',
  '(photo / flat color / data / empty). Generous negative space — if it looks busy, it is wrong.',
  'Thin 1px rules separating information blocks, never heavy boxes or drop shadows.',
  'Contained corner radius on blocks; full radius only on small pill tags.',
  '',
  'TYPOGRAPHY (only if the image needs text): geometric grotesque sans-serif, Satoshi-like.',
  'Headlines and labels in UPPERCASE with open letter-spacing. Numbers and metrics are the hero:',
  'render them very large in a light weight. Keep any text short and correctly spelled.',
  '',
  'PHOTOGRAPHY (if photographic): hard directional light, decisive shadows, real fulfillment',
  'operation — warehouse, loading dock, shipping line, conveyor, pallets — or a macro product shot',
  '(bottle, jar, tube) for beauty, cosmetics, wellness, supplements and performance brands.',
  'No generic smiling stock-photo people, no soft diffuse lighting, no clutter.',
  '',
  'TONE: infrastructure, scale, precision and performance. Institutional and severe, never cute,',
  'never playful, never hand-drawn, never 3D-cartoon.',
  '',
  'LOGO: do NOT draw, letter or invent the Enviagora logo, wordmark, arrow symbol or any other',
  'brand mark, signature or watermark. Leave a clean, empty margin area where the official logo',
  'file will be placed afterwards.',
].join('\n');

/** Anexado a toda geração, com ou sem marca. Evita as falhas mais comuns. */
export const DIRETRIZES_BASE = [
  'No watermark, no signature, no stock-photo badge, no UI chrome, no border frame.',
  'Avoid distorted hands, garbled lettering and misspelled words.',
].join(' ');

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

/**
 * Bloco anexado ao prompt do usuário quando `marca: true`.
 *
 * Duas regras nasceram de erro real em produção:
 *
 * 1. O nome do sistema visual NÃO aparece aqui. Quando aparecia, o modelo
 *    entendia "Autoridade Técnica" como conteúdo e desenhava as palavras dentro
 *    da imagem, em bloco gráfico, com acento errado.
 * 2. A composição em blocos chapados é para PEÇA GRÁFICA. Aplicada a uma foto,
 *    ela cobria metade da cena com um retângulo de cor. Agora o modelo escolhe
 *    o tratamento pelo tipo de imagem pedida.
 */
export const DIRETRIZES_DE_MARCA = [
  'Art direction (follow strictly):',
  '',
  `COLOR: use only this palette — deep green ${PALETA.verdeProfundo}, neon lime ${PALETA.verdeNeon},`,
  `cream ${PALETA.creme}, mist grey ${PALETA.cinzaNevoa}, eucalyptus ${PALETA.eucalipto}.`,
  'At most ONE neon accent in the whole image, and only as a small fill, edge or object —',
  'never as a large area and never behind text. No other colors, no gradients, no glow,',
  'no pastel, no purple, no beige, no orange.',
  '',
  'NO LETTERING. Do not render words, letters, numerals, labels, captions, logos, wordmarks,',
  'arrows-as-symbol, badges or watermarks anywhere in the image — not even decorative or',
  'blurred text. The only exception is when the description above explicitly asks for specific',
  'words. Leave clean, uncluttered margin space so a designer can place the official logo',
  'afterwards.',
  '',
  'TREATMENT — pick by what was asked:',
  '· If a photograph, scene, place, person, product or object was described, keep the whole',
  '  frame photographic. Carry the palette through the real set: painted surfaces, equipment,',
  '  uniforms, packaging, and colour grading. Do NOT paste flat colour blocks, bars, panels or',
  '  shapes over the photo.',
  '· Only if a graphic piece was asked for (post, banner, cover, poster, slide, layout) build the',
  '  modular grid of flat colour blocks, thin 1px rules and generous negative space.',
  '',
  'PHOTOGRAPHY: hard directional light, decisive shadows, real fulfillment operation —',
  'warehouse, loading dock, shipping line, conveyor, pallets — or a macro product shot',
  '(bottle, jar, tube) for beauty, cosmetics, wellness, supplements and performance brands.',
  'No generic smiling stock-photo people, no soft diffuse lighting, no clutter.',
  '',
  'TONE: infrastructure, scale, precision and performance. Institutional and severe, never cute,',
  'never playful, never hand-drawn, never 3D-cartoon.',
].join('\n');

/** Anexado a toda geração, com ou sem marca. Evita as falhas mais comuns. */
export const DIRETRIZES_BASE = [
  'No watermark, no signature, no stock-photo badge, no UI chrome, no border frame.',
  'Avoid distorted hands, garbled lettering and misspelled words.',
].join(' ');

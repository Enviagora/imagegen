/**
 * Montagem do prompt final enviado ao modelo.
 *
 * O usuário escreve em português ou inglês e não sabe (nem precisa saber) como
 * se escreve prompt. Aqui a descrição dele é combinada com o formato, as
 * diretrizes base e — quando `marca: true` — as diretrizes da Enviagora.
 */

import { DIRETRIZES_BASE, DIRETRIZES_DE_MARCA } from './config/marca.js';
import type { Formato } from './config/models.js';

const DICA_DE_FORMATO: Record<Formato, string> = {
  quadrado: 'Square 1:1 composition.',
  vertical: 'Vertical portrait composition for a social feed.',
  horizontal: 'Wide horizontal composition, landscape framing.',
  story: 'Tall 9:16 vertical composition for a full-screen story, with the subject centred and clear margins at top and bottom for overlay text.',
};

export function montarPrompt(args: {
  descricao: string;
  formato: Formato;
  marca: boolean;
  temReferencia: boolean;
}): string {
  const partes = [args.descricao.trim(), DICA_DE_FORMATO[args.formato]];

  if (args.temReferencia) {
    partes.push('Use the provided reference image for style, subject and framing guidance.');
  }
  if (args.marca) {
    partes.push('', DIRETRIZES_DE_MARCA);
  }
  partes.push('', DIRETRIZES_BASE);

  return partes.filter((p) => p !== undefined).join('\n');
}

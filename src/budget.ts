/**
 * Teto de gasto diário.
 *
 * Fase 1/2: contador em memória. O Cloud Run roda com instância única
 * (`--max-instances=1`), então o contador é o gasto real do dia. Se um dia o
 * serviço precisar escalar, trocar este módulo por Firestore — a interface
 * (`reservar` / `confirmar` / `devolver` / `estado`) não muda.
 *
 * O contador zera na virada do dia no fuso configurado (padrão
 * America/Sao_Paulo), não em UTC: "teto diário" precisa bater com o dia de
 * quem usa.
 */

import { config } from './config/env.js';

/** Rascunho custa US$ 0,003: com 2 casas viraria "0.00" e pareceria de graça. */
function usd(valor: number): string {
  return `US$ ${valor.toFixed(valor > 0 && valor < 0.01 ? 3 : 2)}`;
}

export interface EstadoGasto {
  dia: string;
  gastoUsd: number;
  tetoUsd: number;
  restanteUsd: number;
}

let diaCorrente = '';
let gastoUsd = 0;

function diaLocal(): string {
  // en-CA devolve YYYY-MM-DD, que ordena e compara direito.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config().fusoHorario,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function girarDiaSeNecessario(): void {
  const hoje = diaLocal();
  if (hoje !== diaCorrente) {
    diaCorrente = hoje;
    gastoUsd = 0;
  }
}

export function estado(): EstadoGasto {
  girarDiaSeNecessario();
  const teto = config().tetoDiarioUsd;
  return {
    dia: diaCorrente,
    gastoUsd: Number(gastoUsd.toFixed(4)),
    tetoUsd: teto,
    restanteUsd: Number(Math.max(0, teto - gastoUsd).toFixed(4)),
  };
}

export class TetoAtingidoError extends Error {
  constructor(
    readonly custoPedidoUsd: number,
    readonly atual: EstadoGasto,
  ) {
    super(
      `Teto de gasto diário atingido. Já foram gastos ${usd(atual.gastoUsd)} ` +
        `de ${usd(atual.tetoUsd)} hoje (${atual.dia}, fuso ${config().fusoHorario}), ` +
        `e esta geração custaria mais ${usd(custoPedidoUsd)}. ` +
        `Nenhuma imagem foi gerada e nada foi cobrado. ` +
        `O contador zera na virada do dia. Para liberar antes, alguém com acesso ao ` +
        `Cloud Run precisa aumentar a variável TETO_DIARIO_USD.`,
    );
    this.name = 'TetoAtingidoError';
  }
}

/**
 * Debita o custo ANTES de chamar a Replicate. Chamar depois abriria janela para
 * várias gerações simultâneas passarem juntas pelo teto.
 * Se a geração falhar, `devolver` estorna.
 */
export function reservar(custoUsd: number): EstadoGasto {
  girarDiaSeNecessario();
  const teto = config().tetoDiarioUsd;
  if (gastoUsd + custoUsd > teto) {
    throw new TetoAtingidoError(custoUsd, estado());
  }
  gastoUsd += custoUsd;
  return estado();
}

export function devolver(custoUsd: number): EstadoGasto {
  girarDiaSeNecessario();
  gastoUsd = Math.max(0, gastoUsd - custoUsd);
  return estado();
}

/** Só para teste do teto: força o contador para um valor. */
export function forcarGasto(valorUsd: number): EstadoGasto {
  girarDiaSeNecessario();
  gastoUsd = Math.max(0, valorUsd);
  return estado();
}

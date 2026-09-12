/**
 * Teto de gasto diário.
 *
 * O contador mora no Cloud Storage, não na memória do processo. A primeira
 * versão guardava em memória e isso fazia o teto ser uma ilusão: com
 * `min-instances=0` a instância é recolhida por inatividade várias vezes ao dia,
 * e o gasto acumulado voltava a zero junto com ela. Um limite que se reinicia
 * sozinho é pior que nenhum, porque dá falsa segurança.
 *
 * O arquivo é minúsculo e a leitura leva alguns milissegundos, irrelevante perto
 * dos segundos que uma geração demora. A escrita usa pré-condição de geração do
 * GCS, então duas instâncias simultâneas nunca sobrescrevem uma à outra — o
 * serviço roda com `max-instances=1` hoje, mas o contador deixa de depender
 * disso.
 *
 * Sem bucket configurado (desenvolvimento local) ele cai para memória, que é o
 * comportamento certo para quem está rodando na própria máquina.
 */

import { Storage } from '@google-cloud/storage';
import { config } from './config/env.js';
import { log } from './logging.js';

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

interface Registro {
  dia: string;
  gastoUsd: number;
}

let storage: Storage | null = null;
function cliente(): Storage {
  storage ??= new Storage();
  return storage;
}

function diaLocal(): string {
  // en-CA devolve YYYY-MM-DD, que ordena e compara direito.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config().fusoHorario,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function arquivoDoDia(dia: string) {
  return cliente().bucket(config().bucket).file(`contador/${dia}.json`);
}

// --- fallback em memória, usado só sem bucket -------------------------------
let memoriaDia = '';
let memoriaGasto = 0;

function emMemoria(): Registro {
  const hoje = diaLocal();
  if (hoje !== memoriaDia) {
    memoriaDia = hoje;
    memoriaGasto = 0;
  }
  return { dia: memoriaDia, gastoUsd: memoriaGasto };
}

// --- leitura e escrita ------------------------------------------------------

interface Lido extends Registro {
  /** Geração do objeto no GCS; 0 quando ele ainda não existe. */
  geracao: number;
}

async function ler(): Promise<Lido> {
  const dia = diaLocal();
  if (!config().bucket) return { ...emMemoria(), geracao: 0 };

  try {
    const arquivo = arquivoDoDia(dia);
    const [conteudo] = await arquivo.download();
    const registro = JSON.parse(conteudo.toString('utf8')) as Registro;
    const geracao = Number(arquivo.metadata.generation ?? 0);
    // Um arquivo de outro dia não deveria existir neste caminho, mas se
    // existir, ele não conta para hoje.
    return registro.dia === dia
      ? { dia, gastoUsd: registro.gastoUsd, geracao }
      : { dia, gastoUsd: 0, geracao };
  } catch (erro) {
    const codigo = (erro as { code?: number }).code;
    if (codigo === 404) return { dia, gastoUsd: 0, geracao: 0 };
    // Não dá para saber o gasto do dia. Recusar seria derrubar o serviço por
    // causa do contador; seguir em frente arrisca furar o teto. Escolhemos
    // seguir e gritar no log, porque a proteção real de orçamento é o alerta
    // de billing do GCP e o limite da conta da Replicate.
    log.error('não foi possível ler o contador de gasto; seguindo sem ele', {
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return { dia, gastoUsd: 0, geracao: -1 };
  }
}

async function gravar(dia: string, gastoUsd: number, geracao: number): Promise<boolean> {
  if (!config().bucket) {
    memoriaDia = dia;
    memoriaGasto = gastoUsd;
    return true;
  }
  if (geracao < 0) return true; // leitura falhou; não sobrescreve às cegas

  try {
    await arquivoDoDia(dia).save(JSON.stringify({ dia, gastoUsd } satisfies Registro), {
      contentType: 'application/json',
      // Só grava se o objeto continuar como estava quando lemos. `0` significa
      // "só crie se ainda não existir".
      preconditionOpts: { ifGenerationMatch: geracao },
    });
    return true;
  } catch (erro) {
    const codigo = (erro as { code?: number }).code;
    if (codigo === 412) return false; // alguém escreveu antes; quem chamou tenta de novo
    throw erro;
  }
}

// --- API --------------------------------------------------------------------

function comRestante(dia: string, gastoUsd: number): EstadoGasto {
  const teto = config().tetoDiarioUsd;
  return {
    dia,
    gastoUsd: Number(gastoUsd.toFixed(4)),
    tetoUsd: teto,
    restanteUsd: Number(Math.max(0, teto - gastoUsd).toFixed(4)),
  };
}

export async function estado(): Promise<EstadoGasto> {
  const { dia, gastoUsd } = await ler();
  return comRestante(dia, gastoUsd);
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

/** Tentativas de read-modify-write antes de desistir da disputa. */
const TENTATIVAS = 5;

async function ajustar(delta: number, recusarSeEstourar: boolean): Promise<EstadoGasto> {
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const { dia, gastoUsd, geracao } = await ler();
    const novo = Math.max(0, gastoUsd + delta);

    if (recusarSeEstourar && novo > config().tetoDiarioUsd) {
      throw new TetoAtingidoError(delta, comRestante(dia, gastoUsd));
    }
    if (await gravar(dia, novo, geracao)) return comRestante(dia, novo);
  }
  // Cinco colisões seguidas com max-instances=1 não deveria acontecer.
  throw new Error('Não foi possível atualizar o contador de gasto: disputa de escrita persistente.');
}

/**
 * Debita o custo ANTES de chamar a Replicate. Debitar depois abriria janela para
 * várias gerações simultâneas passarem juntas pelo teto.
 * Se a geração falhar, `devolver` estorna.
 */
export function reservar(custoUsd: number): Promise<EstadoGasto> {
  return ajustar(custoUsd, true);
}

export function devolver(custoUsd: number): Promise<EstadoGasto> {
  return ajustar(-custoUsd, false);
}

/** Só para teste do teto: força o contador para um valor. */
export async function forcarGasto(valorUsd: number): Promise<EstadoGasto> {
  const { dia, geracao } = await ler();
  await gravar(dia, Math.max(0, valorUsd), geracao);
  return comRestante(dia, Math.max(0, valorUsd));
}

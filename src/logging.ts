/**
 * Log estruturado. No Cloud Run, uma linha de JSON no stdout vira uma entrada
 * do Cloud Logging com os campos em `jsonPayload`, sem precisar de biblioteca
 * nem de credencial extra.
 */

import { createHash } from 'node:crypto';

type Severidade = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

export interface Campos {
  [chave: string]: unknown;
}

function emitir(severity: Severidade, message: string, campos: Campos = {}): void {
  const linha = JSON.stringify({
    severity,
    message,
    time: new Date().toISOString(),
    ...campos,
  });
  if (severity === 'ERROR' || severity === 'WARNING') process.stderr.write(linha + '\n');
  else process.stdout.write(linha + '\n');
}

export const log = {
  debug: (message: string, campos?: Campos) => emitir('DEBUG', message, campos),
  info: (message: string, campos?: Campos) => emitir('INFO', message, campos),
  warn: (message: string, campos?: Campos) => emitir('WARNING', message, campos),
  error: (message: string, campos?: Campos) => emitir('ERROR', message, campos),
};

/**
 * O prompt pode conter informação do cliente. O log guarda só o hash, o
 * tamanho e as primeiras palavras — o suficiente para agrupar reincidência sem
 * despejar o conteúdo no Cloud Logging.
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 16);
}

/** Evento de auditoria de custo. Um por geração, com ou sem sucesso. */
export interface EventoGeracao extends Campos {
  evento: 'geracao_imagem';
  modelo: string;
  finalidade: string;
  formato: string;
  marca: boolean;
  com_referencia: boolean;
  custo_estimado_usd: number;
  gasto_acumulado_dia_usd: number;
  teto_diario_usd: number;
  prompt_hash: string;
  prompt_chars: number;
  /** E-mail de quem pediu, ou `nao-identificado` com senha compartilhada. */
  solicitante: string;
  duracao_ms: number;
  status: 'ok' | 'erro' | 'bloqueado_por_teto';
  erro?: string;
}

export function registrarGeracao(evento: EventoGeracao): void {
  const nivel = evento.status === 'ok' ? log.info : log.warn;
  nivel(
    `gerar_imagem ${evento.status} · ${evento.finalidade} · ${evento.modelo} · US$ ${evento.custo_estimado_usd}`,
    evento,
  );
}

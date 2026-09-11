/**
 * Servidor MCP e suas ferramentas.
 *
 * Mantenha o número de ferramentas no mínimo: cada uma registrada aqui custa
 * contexto em TODA conversa do Claude, mesmo quando ninguém gera imagem.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from './config/env.js';
import { FINALIDADES, FORMATOS, custoEstimadoUsd, modeloPara } from './config/models.js';
import type { Finalidade, Formato } from './config/models.js';
import { TetoAtingidoError, devolver, estado, reservar } from './budget.js';
import { hashPrompt, log, registrarGeracao } from './logging.js';
import { montarPrompt } from './prompt.js';
import { ReplicateError, baixar, gerar } from './replicate.js';
import { guardar } from './storage.js';

const HOSTS_PROIBIDOS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/** A URL de referência é buscada pela Replicate; só aceitamos HTTPS público. */
function validarReferencia(bruta: string): string {
  let url: URL;
  try {
    url = new URL(bruta);
  } catch {
    throw new Error(`A referência "${bruta}" não é uma URL válida.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('A imagem de referência precisa ser uma URL https:// pública.');
  }
  if (HOSTS_PROIBIDOS.test(url.hostname)) {
    throw new Error('A imagem de referência precisa estar num endereço público — endereços internos não são aceitos.');
  }
  return url.toString();
}

function erro(texto: string): CallToolResult {
  return { content: [{ type: 'text', text: texto }], isError: true };
}

/** "7 dias" lê melhor que "10080 min" para quem recebe o link. */
function validadeLegivel(): string {
  const min = config().urlAssinadaMinutos;
  if (min >= 2880) return `${Math.round(min / 1440)} dias`;
  if (min >= 120) return `${Math.round(min / 60)} horas`;
  return `${min} minutos`;
}

function formatarUsd(valor: number): string {
  // Rascunho custa US$ 0,003: com 2 casas viraria "US$ 0.00" e pareceria de graça.
  return `US$ ${valor.toFixed(valor > 0 && valor < 0.01 ? 3 : 2)}`;
}

export function criarServidor(): McpServer {
  const servidor = new McpServer(
    { name: 'enviagora-imagegen', version: '1.0.0' },
    {
      instructions:
        'Geração de imagem da Enviagora. Use `gerar_imagem` sempre que pedirem uma imagem, ' +
        'arte, foto, ilustração, banner, post ou capa. Escreva o parâmetro `prompt` descrevendo ' +
        'a cena com detalhe — o usuário não precisa saber escrever prompt, você traduz o pedido ' +
        'dele. Use `marca: true` quando a peça for institucional da Enviagora. Prefira a ' +
        'finalidade `rascunho` para explorar ideias e só suba para `final` ou `impressao` quando ' +
        'o usuário aprovar a direção, porque o custo por imagem sobe bastante.',
    },
  );

  servidor.registerTool(
    'gerar_imagem',
    {
      title: 'Gerar imagem',
      description:
        'Gera uma imagem a partir de uma descrição em português ou inglês e devolve a imagem ' +
        'pronta mais um link temporário para download. Use para qualquer pedido de imagem, arte, ' +
        'foto, ilustração, banner, post, capa ou mockup.',
      inputSchema: {
        prompt: z
          .string()
          .min(3, 'Descreva a imagem com pelo menos algumas palavras.')
          .max(4000)
          .describe(
            'Descrição da imagem, em português ou inglês. Quanto mais concreta (sujeito, ' +
              'ambiente, luz, ângulo, cores), melhor o resultado.',
          ),
        finalidade: z
          .enum(FINALIDADES)
          .default('rascunho')
          .describe(
            'Para que serve a imagem. `rascunho` é rápido e barato, para explorar ideia. ' +
              '`final` é a qualidade de publicar. `impressao` é 4K e custa bem mais — só use ' +
              'quando o usuário pedir impressão ou peça grande.',
          ),
        formato: z
          .enum(FORMATOS)
          .default('quadrado')
          .describe('Proporção da imagem. `story` é o 9:16 de story/reels.'),
        marca: z
          .boolean()
          .default(false)
          .describe(
            'Aplica as diretrizes visuais da Enviagora (paleta, composição, fotografia). ' +
              'Use `true` em peça institucional da empresa; `false` em qualquer imagem avulsa.',
          ),
        referencia: z
          .string()
          .optional()
          .describe(
            'URL https:// de uma imagem de referência. Ignorada pelos modelos que não ' +
              'suportam referência — o retorno avisa quando isso acontece.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, finalidade, formato, marca, referencia }): Promise<CallToolResult> => {
      const inicio = Date.now();
      const modelo = modeloPara(finalidade as Finalidade);
      const custo = modelo.custoUsdPorImagem;

      let referenciaValidada: string | undefined;
      let avisoReferencia = '';
      if (referencia) {
        try {
          referenciaValidada = validarReferencia(referencia);
        } catch (e) {
          return erro(e instanceof Error ? e.message : String(e));
        }
        if (!modelo.aceitaReferencia) {
          avisoReferencia =
            `\n⚠️  O modelo da finalidade \`${finalidade}\` (${modelo.rotulo}) não aceita imagem de ` +
            `referência, então ela foi ignorada. Para usar referência, peça com ` +
            `\`finalidade: "final"\` ou \`"impressao"\`.`;
          referenciaValidada = undefined;
        }
      }

      const base = {
        evento: 'geracao_imagem' as const,
        modelo: modelo.slug,
        finalidade,
        formato,
        marca,
        com_referencia: Boolean(referenciaValidada),
        custo_estimado_usd: custo,
        teto_diario_usd: config().tetoDiarioUsd,
        prompt_hash: hashPrompt(prompt),
        prompt_chars: prompt.length,
      };

      // Debita antes de gastar. Estorna se a geração falhar.
      let gasto;
      try {
        gasto = reservar(custo);
      } catch (e) {
        if (e instanceof TetoAtingidoError) {
          registrarGeracao({
            ...base,
            gasto_acumulado_dia_usd: e.atual.gastoUsd,
            duracao_ms: Date.now() - inicio,
            status: 'bloqueado_por_teto',
            erro: 'teto diário atingido',
          });
          return erro(e.message);
        }
        throw e;
      }

      try {
        const promptFinal = montarPrompt({
          descricao: prompt,
          formato: formato as Formato,
          marca,
          temReferencia: Boolean(referenciaValidada),
        });

        const entrada = modelo.buildInput({
          prompt: promptFinal,
          formato: formato as Formato,
          ...(referenciaValidada ? { referencia: referenciaValidada } : {}),
        });

        const prediction = await gerar(modelo.slug, entrada);
        const { bytes, contentType } = await baixar(prediction.urlImagem);

        const armazenada = await guardar({
          bytes,
          contentType,
          urlOrigem: prediction.urlImagem,
          finalidade,
          metadados: {
            modelo: modelo.slug,
            finalidade,
            formato,
            marca: String(marca),
            prompt_hash: base.prompt_hash,
            prediction_id: prediction.predictionId,
          },
        });

        registrarGeracao({
          ...base,
          gasto_acumulado_dia_usd: gasto.gastoUsd,
          duracao_ms: Date.now() - inicio,
          status: 'ok',
        });

        const mb = bytes.byteLength / (1024 * 1024);
        const cabeNoInline = mb <= config().maxInlineMb;

        const linhas = [
          `Imagem gerada com ${modelo.rotulo} (${modelo.resolucao}), finalidade \`${finalidade}\`, formato \`${formato}\`${marca ? ', com as diretrizes da marca Enviagora' : ''}.`,
          '',
          armazenada.destino === 'gcs'
            ? `**Download:** ${armazenada.url}\n(link válido por ${validadeLegivel()})`
            : `**Arquivo salvo em:** ${armazenada.url}\n(modo local — sem Cloud Storage configurado)`,
          '',
          `Custo estimado: ${formatarUsd(custo)} · gasto hoje: ${formatarUsd(gasto.gastoUsd)} de ${formatarUsd(gasto.tetoUsd)}.`,
        ];
        if (!cabeNoInline) {
          linhas.push(
            '',
            `A imagem tem ${mb.toFixed(1)} MB e não foi anexada na resposta para não estourar o ` +
              `contexto. Use o link acima para baixar.`,
          );
        }
        if (avisoReferencia) linhas.push(avisoReferencia);

        const conteudo: CallToolResult['content'] = [];
        if (cabeNoInline) {
          conteudo.push({ type: 'image', data: bytes.toString('base64'), mimeType: contentType });
        }
        conteudo.push({ type: 'text', text: linhas.join('\n') });

        return { content: conteudo };
      } catch (e) {
        const devolvido = devolver(custo);
        const mensagem = e instanceof Error ? e.message : String(e);
        registrarGeracao({
          ...base,
          gasto_acumulado_dia_usd: devolvido.gastoUsd,
          duracao_ms: Date.now() - inicio,
          status: 'erro',
          erro: mensagem,
        });
        if (e instanceof ReplicateError) return erro(mensagem);
        log.error('falha inesperada em gerar_imagem', { erro: mensagem });
        return erro(`Não foi possível gerar a imagem: ${mensagem}`);
      }
    },
  );

  servidor.registerTool(
    'estimar_custo',
    {
      title: 'Estimar custo de geração',
      description:
        'Diz quanto custaria gerar N imagens numa finalidade, e quanto ainda cabe no teto de ' +
        'gasto de hoje. Use antes de gerar um lote grande ou quando perguntarem o preço.',
      inputSchema: {
        finalidade: z.enum(FINALIDADES).default('rascunho').describe('Finalidade a estimar.'),
        quantidade: z.number().int().min(1).max(500).default(1).describe('Quantas imagens.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ finalidade, quantidade }): Promise<CallToolResult> => {
      const modelo = modeloPara(finalidade as Finalidade);
      const total = custoEstimadoUsd(finalidade as Finalidade, quantidade);
      const atual = estado();
      const cabem = Math.floor(atual.restanteUsd / modelo.custoUsdPorImagem);

      const texto = [
        `${quantidade} imagem(ns) em \`${finalidade}\` (${modelo.rotulo}, ${modelo.resolucao}): **${formatarUsd(total)}** ` +
          `— ${formatarUsd(modelo.custoUsdPorImagem)} por imagem.`,
        '',
        `Gasto hoje: ${formatarUsd(atual.gastoUsd)} de ${formatarUsd(atual.tetoUsd)} ` +
          `(restam ${formatarUsd(atual.restanteUsd)}).`,
        total > atual.restanteUsd
          ? `⚠️  Esse lote **não cabe** no teto de hoje. Ainda cabem ${cabem} imagem(ns) nessa finalidade.`
          : `Cabe no teto de hoje. Ainda cabem ${cabem} imagem(ns) nessa finalidade.`,
      ].join('\n');

      return { content: [{ type: 'text', text: texto }] };
    },
  );

  return servidor;
}

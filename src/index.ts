/**
 * Entrypoint HTTP.
 *
 * Transporte MCP: Streamable HTTP (o SSE está em descontinuação e não é
 * exposto aqui). O servidor roda sem sessão — cada POST /mcp monta um
 * `McpServer` e um transporte novos e os descarta no fim. Isso casa com o Cloud
 * Run escalando a zero: não há estado de sessão para perder.
 */

import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  authorizeGet,
  authorizePost,
  googleCallback,
  exigirAutenticacao,
  metadadosRecursoProtegido,
  metadadosServidorAutorizacao,
  tokenPost,
} from './auth.js';
import { config } from './config/env.js';
import { estado } from './budget.js';
import { MODELO_POR_FINALIDADE } from './config/models.js';
import { log } from './logging.js';
import { criarServidor } from './tools.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use('/mcp', express.json({ limit: '4mb' }));
app.use(['/authorize', '/token'], express.urlencoded({ extended: false }));
app.use(['/authorize', '/token'], express.json());

// --- Descoberta de OAuth ----------------------------------------------------
// O Claude busca estes dois documentos antes de tentar autorizar. Sem eles, o
// connector gerenciado pela organização falha a conexão.
const semCache = (res: Response) => res.setHeader('Cache-Control', 'no-store');

app.get(
  ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  (_req, res) => {
    semCache(res);
    res.json(metadadosRecursoProtegido());
  },
);

app.get(
  ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'],
  (_req, res) => {
    semCache(res);
    res.json(metadadosServidorAutorizacao());
  },
);

app.get('/authorize', authorizeGet);
app.post('/authorize', authorizePost);
app.post('/token', tokenPost);
// Para onde o Google devolve a pessoa depois de ela escolher a conta.
app.get('/auth/google/callback', (req, res) => void googleCallback(req, res));

// --- MCP --------------------------------------------------------------------

async function tratarMcp(req: Request, res: Response): Promise<void> {
  const servidor = criarServidor();
  const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transporte.close();
    void servidor.close();
  });

  try {
    await servidor.connect(transporte);
    await transporte.handleRequest(req, res, req.body);
  } catch (erro) {
    log.error('falha ao tratar requisição MCP', {
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Erro interno do servidor MCP.' },
        id: null,
      });
    }
  }
}

app.post('/mcp', exigirAutenticacao, (req, res) => void tratarMcp(req, res));

// O modo sem sessão não mantém stream aberto para notificação do servidor.
app.get('/mcp', exigirAutenticacao, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Este servidor opera sem sessão: use POST /mcp.' },
    id: null,
  });
});
app.delete('/mcp', exigirAutenticacao, (_req, res) => res.status(204).end());

// --- Operação ---------------------------------------------------------------

// `/health`, não `/healthz`: o Cloud Run reserva caminhos terminados em "z" e o
// Google Frontend intercepta esses pedidos, devolvendo um 404 dele antes de a
// requisição chegar aqui. Não renomeie de volta.
app.get('/health', (_req, res) => {
  const gasto = estado();
  res.json({
    ok: true,
    servico: config().nomeServico,
    ambiente: config().ambiente,
    modelos: MODELO_POR_FINALIDADE,
    gasto_hoje_usd: gasto.gastoUsd,
    teto_diario_usd: gasto.tetoUsd,
    dia: gasto.dia,
  });
});

app.get('/', (_req, res) => {
  res
    .status(200)
    .type('text/plain; charset=utf-8')
    .send('Enviagora · servidor MCP de geração de imagem. Endpoint MCP: POST /mcp\n');
});

// --- Boot -------------------------------------------------------------------

function subir(): void {
  let cfg;
  try {
    cfg = config();
  } catch (erro) {
    // Falha de configuração mata o processo agora, não na primeira geração.
    log.error('configuração inválida — o serviço não vai subir', {
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    process.exit(1);
  }

  const servidorHttp = app.listen(cfg.porta, () => {
    log.info('servidor MCP no ar', {
      porta: cfg.porta,
      ambiente: cfg.ambiente,
      autenticacao: cfg.oauthHabilitado ? 'oauth' : cfg.tokenEstatico ? 'token-estatico' : 'nenhuma (local)',
      armazenamento: cfg.bucket ? `gcs://${cfg.bucket}` : 'disco local',
      teto_diario_usd: cfg.tetoDiarioUsd,
      modelos: MODELO_POR_FINALIDADE,
    });
  });

  // O Cloud Run manda SIGTERM antes de recolher a instância.
  const desligar = (sinal: string) => {
    log.info('desligando', { sinal });
    servidorHttp.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => desligar('SIGTERM'));
  process.on('SIGINT', () => desligar('SIGINT'));
}

subir();

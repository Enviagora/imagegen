/**
 * Armazenamento da imagem gerada.
 *
 * Produção: Cloud Storage + URL assinada de validade curta.
 * Fase 1 (sem GCS_BUCKET): grava em disco e devolve o caminho local, para dar
 * para testar tudo no inspector do MCP sem depender do GCP.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { Storage } from '@google-cloud/storage';
import { config } from './config/env.js';
import { log } from './logging.js';

export interface ImagemArmazenada {
  /** URL assinada do Cloud Storage, ou caminho local na fase 1. */
  url: string;
  /** Onde ela foi parar: `gcs` ou `local`. */
  destino: 'gcs' | 'local';
  /** Momento em que a URL assinada expira (null quando local). */
  expiraEm: Date | null;
  objeto: string;
}

let storage: Storage | null = null;

function cliente(): Storage {
  storage ??= new Storage();
  return storage;
}

function extensaoDe(contentType: string, urlOrigem: string): string {
  const porTipo: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
  };
  const conhecida = porTipo[contentType.split(';')[0]!.trim().toLowerCase()];
  if (conhecida) return conhecida;
  const daUrl = extname(new URL(urlOrigem).pathname);
  return daUrl && daUrl.length <= 5 ? daUrl : '.png';
}

function nomeDoObjeto(finalidade: string, extensao: string): string {
  const agora = new Date();
  const dia = agora.toISOString().slice(0, 10);
  return `${dia}/${finalidade}/${agora.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}${extensao}`;
}

export async function guardar(args: {
  bytes: Buffer;
  contentType: string;
  urlOrigem: string;
  finalidade: string;
  metadados: Record<string, string>;
}): Promise<ImagemArmazenada> {
  const { bucket, urlAssinadaMinutos, diretorioLocal } = config();
  const extensao = extensaoDe(args.contentType, args.urlOrigem);
  const objeto = nomeDoObjeto(args.finalidade, extensao);

  if (!bucket) {
    const caminho = resolve(diretorioLocal, objeto);
    await mkdir(resolve(caminho, '..'), { recursive: true });
    await writeFile(caminho, args.bytes);
    log.info('imagem gravada em disco (modo local, sem GCS_BUCKET)', { caminho });
    return { url: caminho, destino: 'local', expiraEm: null, objeto };
  }

  const arquivo = cliente().bucket(bucket).file(objeto);
  await arquivo.save(args.bytes, {
    contentType: args.contentType,
    // O bucket é privado; o acesso é só pela URL assinada.
    metadata: { cacheControl: 'private, max-age=3600', metadata: args.metadados },
  });

  const expiraEm = new Date(Date.now() + urlAssinadaMinutos * 60_000);
  const [url] = await arquivo.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiraEm,
  });

  return { url, destino: 'gcs', expiraEm, objeto };
}

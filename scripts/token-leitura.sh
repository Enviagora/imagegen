#!/usr/bin/env bash
#
# Gera um token de LEITURA, válido por 1 hora, para o Claude diagnosticar o
# serviço direto pelas APIs do Google em vez de pedir que você rode comando e
# cole a saída.
#
#   ./scripts/token-leitura.sh
#
# O que esse token PODE: ler estado do Cloud Run, logs, builds e imagens.
# O que ele NÃO PODE: ler o Secret Manager (nem o token da Replicate, nem a
# senha do OAuth), implantar, apagar, mexer em IAM ou gastar dinheiro.
#
# Ele expira sozinho em 1 hora. Não existe arquivo de chave em lugar nenhum —
# o token é gerado por impersonação e some quando expira.

set -euo pipefail

PROJETO="${PROJETO:-enviagora-mcp}"
LEITOR="${LEITOR:-mcp-leitor}"
EMAIL="${LEITOR}@${PROJETO}.iam.gserviceaccount.com"
EU="$(gcloud config get-value account 2>/dev/null)"

gcloud config set project "${PROJETO}" >/dev/null 2>&1

if ! gcloud iam service-accounts describe "${EMAIL}" >/dev/null 2>&1; then
  echo "Criando a conta de leitura ${EMAIL}..."
  gcloud iam service-accounts create "${LEITOR}" \
    --display-name="Diagnóstico somente leitura (Claude)" >/dev/null

  # Só leitura, e de propósito sem nada de Secret Manager.
  for papel in roles/run.viewer \
               roles/logging.viewer \
               roles/cloudbuild.builds.viewer \
               roles/artifactregistry.reader \
               roles/monitoring.viewer; do
    gcloud projects add-iam-policy-binding "${PROJETO}" \
      --member="serviceAccount:${EMAIL}" --role="${papel}" --condition=None >/dev/null
    echo "  ${papel}"
  done

  # Você passa a poder gerar token em nome dela.
  gcloud iam service-accounts add-iam-policy-binding "${EMAIL}" \
    --member="user:${EU}" --role=roles/iam.serviceAccountTokenCreator >/dev/null
  echo "Conta criada."
  echo "Esperando a permissão propagar..."
  sleep 15
fi

TOKEN="$(gcloud auth print-access-token --impersonate-service-account="${EMAIL}" 2>/dev/null)" || {
  echo "Não consegui gerar o token. Se a conta acabou de ser criada, espere 1 minuto e rode de novo."
  exit 1
}

cat <<FIM

================== COLE O BLOCO ABAIXO NO CHAT ==================
PROJETO=${PROJETO}
REGIAO=${REGIAO:-southamerica-east1}
TOKEN_LEITURA=${TOKEN}
=================================================================

Expira em 1 hora. É somente leitura e não alcança o Secret Manager.
Para revogar antes da hora:
  gcloud iam service-accounts remove-iam-policy-binding ${EMAIL} \\
    --member="user:${EU}" --role=roles/iam.serviceAccountTokenCreator
FIM

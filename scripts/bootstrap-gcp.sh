#!/usr/bin/env bash
#
# Provisionamento do projeto no GCP. Roda UMA VEZ, por alguém com permissão de
# owner no projeto. Idempotente: pode rodar de novo sem estragar nada.
#
# Uso:
#   PROJECT_ID=enviagora-mcp ./scripts/bootstrap-gcp.sh
#
# Este script NÃO contém segredo nenhum. Ele pede os segredos no terminal e os
# grava direto no Secret Manager; nada é escrito em disco nem fica no histórico
# do shell.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?defina PROJECT_ID=... antes de rodar}"
REGIAO="${REGIAO:-southamerica-east1}"
SERVICO="${SERVICO:-imagegen}"
REPO_AR="${REPO_AR:-mcp}"
BUCKET="${BUCKET:-enviagora-mcp-imagegen}"
CONTA="${CONTA:-mcp-imagegen}"
EMAIL_CONTA="${CONTA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Projeto ${PROJECT_ID} · região ${REGIAO}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Habilitando APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com

echo "==> Artifact Registry"
gcloud artifacts repositories describe "${REPO_AR}" --location="${REGIAO}" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${REPO_AR}" \
    --repository-format=docker --location="${REGIAO}" \
    --description="Imagens dos servidores MCP da Enviagora"

echo "==> Conta de serviço ${EMAIL_CONTA}"
gcloud iam service-accounts describe "${EMAIL_CONTA}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${CONTA}" \
    --display-name="MCP imagegen (Cloud Run)"

echo "==> Bucket gs://${BUCKET} (privado)"
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${REGIAO}" \
    --uniform-bucket-level-access \
    --public-access-prevention

# As imagens não precisam viver para sempre; o link assinado dura 1h.
cat > /tmp/ciclo-vida-imagegen.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":90}}]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/ciclo-vida-imagegen.json
rm -f /tmp/ciclo-vida-imagegen.json

echo "==> Papéis da conta de serviço (mínimo necessário)"
# Escreve e assina URL dentro do bucket — e só dentro dele.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${EMAIL_CONTA}" --role=roles/storage.objectAdmin >/dev/null
# Assinar URL v4 sem chave em disco exige assinar via IAM.
gcloud iam service-accounts add-iam-policy-binding "${EMAIL_CONTA}" \
  --member="serviceAccount:${EMAIL_CONTA}" --role=roles/iam.serviceAccountTokenCreator >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${EMAIL_CONTA}" --role=roles/logging.logWriter --condition=None >/dev/null

echo "==> Segredos no Secret Manager"
criar_segredo() {
  local nome="$1" rotulo="$2"
  if gcloud secrets describe "${nome}" >/dev/null 2>&1; then
    echo "    ${nome}: já existe, mantido."
    return
  fi
  echo -n "    ${rotulo}: "
  read -rs valor
  echo
  printf '%s' "${valor}" | gcloud secrets create "${nome}" --data-file=- --replication-policy=automatic >/dev/null
  unset valor
  gcloud secrets add-iam-policy-binding "${nome}" \
    --member="serviceAccount:${EMAIL_CONTA}" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "    ${nome}: criado."
}

gerar_segredo() {
  local nome="$1"
  if gcloud secrets describe "${nome}" >/dev/null 2>&1; then
    echo "    ${nome}: já existe, mantido."
    return
  fi
  openssl rand -base64 48 | tr -d '\n' | \
    gcloud secrets create "${nome}" --data-file=- --replication-policy=automatic >/dev/null
  gcloud secrets add-iam-policy-binding "${nome}" \
    --member="serviceAccount:${EMAIL_CONTA}" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "    ${nome}: gerado automaticamente."
}

criar_segredo replicate-api-token "cole o token da Replicate (r8_...)"
gerar_segredo  oauth-client-id
gerar_segredo  oauth-client-secret
criar_segredo oauth-senha "escolha a senha que o time vai digitar ao conectar o connector"
gerar_segredo  oauth-assinatura

echo "==> Permissão do Cloud Build para fazer o deploy"
NUMERO=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
for papel in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${NUMERO}@cloudbuild.gserviceaccount.com" \
    --role="${papel}" --condition=None >/dev/null
done

echo
echo "Pronto. Próximos passos:"
echo "  1. gcloud builds submit --config=cloudbuild.yaml --region=${REGIAO} \\"
echo "       --substitutions=_REGIAO=${REGIAO},_SERVICO=${SERVICO},_BUCKET=${BUCKET}"
echo "  2. Pegue o Client ID e o Client Secret para colar no connector:"
echo "       gcloud secrets versions access latest --secret=oauth-client-id"
echo "       gcloud secrets versions access latest --secret=oauth-client-secret"

#!/usr/bin/env bash
#
# Liga o login pelo Google Workspace e implanta. Roda UMA vez.
#
#   ./scripts/ligar-google.sh 228974383723-xxxxx.apps.googleusercontent.com
#
# O ID do cliente vem por argumento (ele é público no OAuth, não é segredo).
# A chave secreta é digitada aqui, não fica no histórico do shell e não passa
# por lugar nenhum além do Secret Manager.
#
# Idempotente: se os segredos já existirem, acrescenta uma versão nova.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PROJETO="${PROJETO:-enviagora-mcp}"
SA_RUN="mcp-imagegen@${PROJETO}.iam.gserviceaccount.com"
SA_DEPLOY="mcp-deployer@${PROJETO}.iam.gserviceaccount.com"

CLIENT_ID="${1:-}"
if [ -z "${CLIENT_ID}" ]; then
  echo "Uso: $0 <ID do cliente OAuth do Google>"
  echo "Ex.: $0 228974383723-abc123.apps.googleusercontent.com"
  exit 2
fi

gcloud config set project "${PROJETO}" >/dev/null 2>&1

guardar() {
  local nome="$1" valor="$2"
  if gcloud secrets describe "${nome}" >/dev/null 2>&1; then
    printf '%s' "${valor}" | gcloud secrets versions add "${nome}" --data-file=- >/dev/null \
      && echo "  ${nome}: versão nova gravada"
  else
    printf '%s' "${valor}" | gcloud secrets create "${nome}" --data-file=- \
      --replication-policy=automatic >/dev/null && echo "  ${nome}: criado"
  fi
  gcloud secrets add-iam-policy-binding "${nome}" \
    --member="serviceAccount:${SA_RUN}" \
    --role=roles/secretmanager.secretAccessor >/dev/null 2>&1
}

echo "==> Chave secreta do cliente OAuth do Google"
echo "    (cole e dê Enter — a tela não mostra o que você digita)"
printf '    > '
read -rs SEGREDO
echo
if [ -z "${SEGREDO}" ]; then
  echo "Nada foi digitado. Abortando sem alterar nada."
  exit 1
fi

echo "==> Gravando no Secret Manager"
guardar google-oauth-client-id "${CLIENT_ID}"
guardar google-oauth-client-secret "${SEGREDO}"
unset SEGREDO

echo "==> Permitindo que a conta de deploy enxergue que o segredo existe"
# Só metadado, nunca o valor. É assim que o cloudbuild decide entre senha e
# Google sem precisar de uma flag que alguém esqueça de virar.
gcloud projects add-iam-policy-binding "${PROJETO}" \
  --member="serviceAccount:${SA_DEPLOY}" \
  --role=roles/secretmanager.viewer --condition=None >/dev/null 2>&1 \
  && echo "  ok"

echo
echo "==> Implantando"
exec ./scripts/subir.sh

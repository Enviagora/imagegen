#!/usr/bin/env bash
#
# Implanta e verifica o servidor MCP, do zero ao teste de geração real.
#
#   ./scripts/subir.sh
#
# Faz tudo sozinho: constrói, implanta, conserta o que der para consertar
# (ingress, BASE_URL), espera o serviço responder, diagnostica se não responder e
# no fim roda o teste ponta a ponta passando pelo OAuth como o Claude faria.
# Pode rodar quantas vezes quiser — nada aqui é destrutivo.

set -uo pipefail

# Roda a partir da raiz do repositório, não importa de onde foi chamado.
cd "$(dirname "$0")/.." || exit 1

PROJETO="${PROJETO:-enviagora-mcp}"
REGIAO="${REGIAO:-southamerica-east1}"
SERVICO="${SERVICO:-imagegen}"
DEPLOYER="${DEPLOYER:-mcp-deployer@${PROJETO}.iam.gserviceaccount.com}"
LOG_BUILD="$(mktemp)"

verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$*"; }
titulo()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }

desistir() {
  vermelho "
$*"
  echo "
Manda esta saída inteira que eu corrijo o repositório."
  exit 1
}

gcloud config set project "${PROJETO}" >/dev/null 2>&1

# ---------------------------------------------------------------------------
titulo "1/6 · Construindo e implantando"
# ---------------------------------------------------------------------------
if ! gcloud builds submit --config=cloudbuild.yaml --region="${REGIAO}" \
      --service-account="projects/${PROJETO}/serviceAccounts/${DEPLOYER}" \
      2>&1 | tee "${LOG_BUILD}"; then

  ID_BUILD=$(grep -oE '/builds/[0-9a-f-]{36}' "${LOG_BUILD}" | head -1 | cut -d/ -f3)
  if [ -n "${ID_BUILD}" ]; then
    echo
    vermelho "--- últimas 60 linhas do log do build ---"
    gcloud builds log "${ID_BUILD}" --region="${REGIAO}" 2>/dev/null | tail -60
  fi
  desistir "O build falhou."
fi
verde "build e deploy concluídos"

# ---------------------------------------------------------------------------
titulo "2/6 · Descobrindo a URL do serviço"
# ---------------------------------------------------------------------------
URL=$(gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
        --format='value(status.url)' 2>/dev/null)
[ -n "${URL}" ] || desistir "O serviço ${SERVICO} não existe em ${REGIAO} depois do deploy."
verde "${URL}"

BASE_NO_SERVICO=$(gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
  --format='value(spec.template.spec.containers[0].env)' 2>/dev/null \
  | tr ';' '\n' | grep -o "BASE_URL[^,}]*" | head -1)
echo "   variável gravada no serviço: ${BASE_NO_SERVICO:-(não encontrada)}"

# ---------------------------------------------------------------------------
titulo "3/6 · Conferindo o ingress"
# ---------------------------------------------------------------------------
# Serviço com ingress interno responde 404 a quem vem de fora — é o sintoma
# clássico de "implantou mas a URL não abre".
INGRESS=$(gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
  --format='value(metadata.annotations."run.googleapis.com/ingress")' 2>/dev/null)
INGRESS="${INGRESS:-all}"
echo "   ingress atual: ${INGRESS}"

if [ "${INGRESS}" != "all" ]; then
  echo "   tentando abrir para tráfego externo..."
  if gcloud run services update "${SERVICO}" --region="${REGIAO}" --ingress=all 2>&1; then
    verde "ingress alterado para all"
  else
    echo
    vermelho "Não foi possível abrir o ingress. Política da organização:"
    gcloud resource-manager org-policies describe constraints/run.allowedIngress \
      --project="${PROJETO}" --effective 2>&1 | sed 's/^/   /'
    desistir "O Claude não consegue alcançar um serviço com ingress interno.
Um admin da organização enviagora.com.br precisa liberar
constraints/run.allowedIngress para este projeto. Não há contorno técnico."
  fi
else
  verde "aberto para tráfego externo"
fi

# ---------------------------------------------------------------------------
titulo "4/6 · Esperando o serviço responder"
# ---------------------------------------------------------------------------
CODIGO=""
for tentativa in 1 2 3 4 5 6 7 8; do
  CODIGO=$(curl -s -o /tmp/healthz.json -w '%{http_code}' --max-time 30 "${URL}/healthz")
  [ "${CODIGO}" = "200" ] && break
  echo "   tentativa ${tentativa}: HTTP ${CODIGO}, esperando 10s (rota recém-criada demora a propagar)"
  sleep 10
done

if [ "${CODIGO}" != "200" ]; then
  echo
  vermelho "--- log do container ---"
  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICO}\"" \
    --project="${PROJETO}" --limit=40 --order=asc \
    --format='value(jsonPayload.message,textPayload)' 2>/dev/null | sed 's/^/   /'
  echo
  vermelho "--- estado da revisão ---"
  gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
    --format='value(status.conditions)' 2>/dev/null | tr ';' '\n' | sed 's/^/   /'
  desistir "O serviço não respondeu 200 em /healthz (último código: ${CODIGO})."
fi
verde "/healthz respondeu 200"
python3 -m json.tool < /tmp/healthz.json 2>/dev/null | sed 's/^/   /' || cat /tmp/healthz.json

# ---------------------------------------------------------------------------
titulo "5/6 · Teste ponta a ponta (OAuth + geração real)"
# ---------------------------------------------------------------------------
export MCP_CLIENT_ID=$(gcloud secrets versions access latest --secret=oauth-client-id)
export MCP_CLIENT_SECRET=$(gcloud secrets versions access latest --secret=oauth-client-secret)
export MCP_SENHA=$(gcloud secrets versions access latest --secret=oauth-senha)

python3 scripts/teste-ponta-a-ponta.py "${URL}"
RESULTADO=$?
unset MCP_CLIENT_ID MCP_CLIENT_SECRET MCP_SENHA

if [ "${RESULTADO}" != "0" ]; then
  echo
  vermelho "--- log do container (pode explicar a falha acima) ---"
  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICO}\"" \
    --project="${PROJETO}" --limit=25 --order=desc \
    --format='value(jsonPayload.message,textPayload)' 2>/dev/null | sed 's/^/   /'
  desistir "O teste ponta a ponta falhou."
fi

# ---------------------------------------------------------------------------
titulo "6/6 · Tudo pronto"
# ---------------------------------------------------------------------------
verde "O servidor MCP está no ar e gerando imagem."
cat <<FIM

Para adicionar o connector no Claude:

  URL do servidor MCP   ${URL}/mcp

  Em "Advanced settings", cole:
    OAuth Client ID       $(gcloud secrets versions access latest --secret=oauth-client-id)
    OAuth Client Secret   (rode: gcloud secrets versions access latest --secret=oauth-client-secret)

  Na primeira conexão o Claude abre a tela de autorização. A senha é a que você
  guardou em oauth-senha.

A imagem do teste ficou em ~/teste-imagegen.png — dá para abrir pelo editor do
Cloud Shell e conferir se o resultado com a marca ficou bom.
FIM

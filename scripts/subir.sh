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
titulo "1/7 · Construindo e implantando"
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
titulo "2/7 · Levantando as URLs do serviço"
# ---------------------------------------------------------------------------
# Um serviço do Cloud Run pode ter mais de uma URL (a determinística
# servico-numero.regiao.run.app e a antiga, com hash), e `status.url` nem sempre
# devolve a que realmente serve. Em vez de confiar numa, testamos todas.
NUMERO=$(gcloud projects describe "${PROJETO}" --format='value(projectNumber)' 2>/dev/null)

CANDIDATAS=$(
  {
    gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
      --format='value(status.url)' 2>/dev/null
    gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
      --format='value(metadata.annotations."run.googleapis.com/urls")' 2>/dev/null \
      | tr -d '[]"' | tr ',' '\n'
    echo "https://${SERVICO}-${NUMERO}.${REGIAO}.run.app"
  } | sed 's/[[:space:]]//g' | grep -E '^https://' | sort -u
)
[ -n "${CANDIDATAS}" ] || desistir "O serviço ${SERVICO} não existe em ${REGIAO} depois do deploy."
echo "${CANDIDATAS}" | sed 's/^/   /'

# ---------------------------------------------------------------------------
titulo "3/7 · Conferindo o ingress"
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
constraints/run.allowedIngress para este projeto."
  fi
else
  verde "aberto para tráfego externo"
fi

# O teto de gasto vive na memória do processo. Com mais de uma instância, cada
# uma teria o próprio contador e o teto diário passaria a valer N vezes.
MAX=$(gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
  --format='value(spec.template.metadata.annotations."autoscaling.knative.dev/maxScale")' 2>/dev/null)
echo "   máximo de instâncias: ${MAX:-(não definido)}"
if [ "${MAX}" != "1" ]; then
  vermelho "   ATENÇÃO: com ${MAX:-N} instâncias, cada uma tem seu próprio contador de gasto"
  vermelho "   e o teto diário de US\$ 10 passa a valer por instância, não no total."
  echo "   corrigindo para 1..."
  gcloud run services update "${SERVICO}" --region="${REGIAO}" --max-instances=1 >/dev/null 2>&1 \
    && verde "máximo de instâncias fixado em 1" \
    || vermelho "   não consegui corrigir — o teto de gasto NÃO é confiável assim"
else
  verde "instância única (o contador de gasto é o gasto real)"
fi

# A URL automática *.run.app pode estar desligada por anotação. Quando está, o
# serviço fica saudável e mesmo assim responde 404 a tudo que vem de fora.
DESLIGADA=$(gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
  --format='value(metadata.annotations."run.googleapis.com/default-url-disabled")' 2>/dev/null)
echo "   URL padrão desabilitada: ${DESLIGADA:-false}"
if [ "${DESLIGADA}" = "true" ] || [ "${DESLIGADA}" = "True" ]; then
  echo "   reativando a URL padrão..."
  if gcloud run services update "${SERVICO}" --region="${REGIAO}" --default-url 2>/dev/null \
     || gcloud beta run services update "${SERVICO}" --region="${REGIAO}" --default-url 2>&1; then
    verde "URL padrão reativada"
    sleep 10
  else
    desistir "A URL automática do Cloud Run está desabilitada e não consegui reativar —
provavelmente uma política da organização enviagora.com.br impede.
Sem ela, o serviço só fica acessível por balanceador de carga ou domínio próprio,
e isso precisa de um admin da organização."
  fi
fi

# ---------------------------------------------------------------------------
titulo "4/7 · Descobrindo qual URL realmente responde"
# Atenção: o caminho sondado NÃO pode terminar em "z". O Cloud Run reserva
# esses caminhos e o Google Frontend os intercepta com um 404 próprio, antes de
# chegar no container — foi o que mascarou um serviço saudável por várias
# tentativas aqui.
# ---------------------------------------------------------------------------
URL=""
for tentativa in 1 2 3 4 5 6; do
  while read -r candidata; do
    [ -n "${candidata}" ] || continue
    CODIGO=$(curl -s -o /tmp/health.json -w '%{http_code}' --max-time 25 "${candidata}/health")
    printf '   %-58s HTTP %s\n' "${candidata}" "${CODIGO}"
    if [ "${CODIGO}" = "200" ]; then URL="${candidata}"; break; fi
  done <<< "${CANDIDATAS}"
  [ -n "${URL}" ] && break
  [ "${tentativa}" = "6" ] && break
  echo "   nenhuma respondeu ainda; esperando 10s (rota nova demora a propagar)"
  sleep 10
done

if [ -z "${URL}" ]; then
  echo
  vermelho "--- políticas da organização que afetam o Cloud Run ---"
  for c in constraints/run.allowedIngress constraints/run.allowedVPCEgress; do
    echo "   ${c}:"
    gcloud resource-manager org-policies describe "${c}" \
      --project="${PROJETO}" --effective 2>&1 | sed 's/^/     /'
  done
  echo
  vermelho "--- divisão de tráfego entre revisões ---"
  gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
    --format='value(status.traffic)' 2>/dev/null | tr ';' '\n' | sed 's/^/   /'
  echo
  vermelho "--- anotações do serviço ---"
  gcloud run services describe "${SERVICO}" --region="${REGIAO}" \
    --format='value(metadata.annotations)' 2>/dev/null | tr ';' '\n' | sed 's/^/   /'
  echo
  vermelho "--- log do container ---"
  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICO}\"" \
    --project="${PROJETO}" --limit=25 --order=desc \
    --format='value(jsonPayload.message,textPayload)' 2>/dev/null | sed 's/^/   /'
  desistir "O container está saudável mas nenhuma URL do Cloud Run responde.
As anotações e políticas acima devem dizer por quê — manda essa saída inteira."
fi
verde "respondendo em ${URL}"
python3 -m json.tool < /tmp/health.json 2>/dev/null | sed 's/^/   /' || cat /tmp/health.json

# ---------------------------------------------------------------------------
titulo "5/7 · Garantindo que o BASE_URL do OAuth é essa URL"
# ---------------------------------------------------------------------------
ANUNCIADO=$(curl -s --max-time 25 "${URL}/.well-known/oauth-protected-resource" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("resource",""))' 2>/dev/null)
echo "   o servidor anuncia: ${ANUNCIADO:-(nada)}"
if [ "${ANUNCIADO}" != "${URL}/mcp" ]; then
  echo "   corrigindo para ${URL}..."
  gcloud run services update "${SERVICO}" --region="${REGIAO}" \
    --update-env-vars="BASE_URL=${URL}" >/dev/null 2>&1 \
    || desistir "Não consegui corrigir o BASE_URL."
  sleep 5
  verde "BASE_URL corrigido"
else
  verde "já está correto"
fi

# ---------------------------------------------------------------------------
titulo "6/7 · Teste ponta a ponta (OAuth + geração real)"
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
titulo "7/7 · Tudo pronto"
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

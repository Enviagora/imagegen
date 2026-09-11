#!/usr/bin/env python3
"""
Teste ponta a ponta do servidor MCP em produção.

Faz o mesmo caminho que o Claude faz: descobre os metadados de OAuth, passa pelo
/authorize com PKCE, troca o código por um access token e então chama
`gerar_imagem` de verdade — inclusive gastando os ~US$ 0,003 de um rascunho.

Uso:
    MCP_CLIENT_ID=... MCP_CLIENT_SECRET=... MCP_SENHA=... \
      teste-ponta-a-ponta.py BASE_URL [--sem-imagem]

Os segredos vêm por variável de ambiente, não por argumento, para não ficarem
visíveis na lista de processos. Nenhum deles é impresso.
"""

import base64
import hashlib
import http.client
import json
import os
import secrets
import sys
import urllib.parse

REDIRECT = "http://localhost:9999/callback"  # loopback é aceito pelo servidor


class Falha(Exception):
    pass


def conectar(base):
    u = urllib.parse.urlparse(base)
    local = u.hostname in ("localhost", "127.0.0.1")
    if u.scheme == "http" and local:
        return http.client.HTTPConnection(u.netloc, timeout=300), u.path.rstrip("/")
    if u.scheme != "https":
        raise Falha(f"BASE_URL precisa ser https://, recebido {base!r}")
    return http.client.HTTPSConnection(u.netloc, timeout=300), u.path.rstrip("/")


def pedir(base, metodo, caminho, corpo=None, cabecalhos=None):
    conn, prefixo = conectar(base)
    try:
        conn.request(metodo, prefixo + caminho, corpo, cabecalhos or {})
        r = conn.getresponse()
        dados = r.read()
        # Nomes de header vêm em minúsculas em produção (o Google Frontend
        # normaliza, como o HTTP/2 exige) e com a caixa original quando se fala
        # direto com o Node. Normalizamos para a busca não depender disso.
        return r.status, {k.lower(): v for k, v in r.getheaders()}, dados
    finally:
        conn.close()


def ok(msg):
    print(f"  \033[32mOK\033[0m   {msg}")


def erro(msg):
    print(f"  \033[31mFALHA\033[0m {msg}")


def main():
    argv = [a for a in sys.argv[1:] if a != "--sem-imagem"]
    gerar = "--sem-imagem" not in sys.argv[1:]

    if len(argv) == 4:  # forma antiga, tudo por argumento
        base, client_id, client_secret, senha = argv
    elif len(argv) == 1:
        base = argv[0]
        client_id = os.environ.get("MCP_CLIENT_ID", "")
        client_secret = os.environ.get("MCP_CLIENT_SECRET", "")
        senha = os.environ.get("MCP_SENHA", "")
    else:
        print(__doc__)
        return 2

    faltando = [n for n, v in (("MCP_CLIENT_ID", client_id),
                               ("MCP_CLIENT_SECRET", client_secret),
                               ("MCP_SENHA", senha)) if not v]
    if faltando:
        raise Falha("faltam variáveis de ambiente: " + ", ".join(faltando))

    base = base.rstrip("/")
    senha = senha.strip()

    print("\n1. Metadados de OAuth")
    for caminho, chave in (
        ("/.well-known/oauth-protected-resource", "resource"),
        ("/.well-known/oauth-authorization-server", "authorization_endpoint"),
    ):
        st, _, corpo = pedir(base, "GET", caminho)
        if st != 200:
            raise Falha(f"{caminho} respondeu {st}")
        meta = json.loads(corpo)
        if chave not in meta:
            raise Falha(f"{caminho} não trouxe {chave}")
        ok(f"{caminho} -> {meta[chave]}")
        if chave == "resource":
            # O servidor anuncia aqui o BASE_URL que recebeu. Se ele não for a
            # URL por onde estamos falando com ele, o Claude tenta autorizar num
            # endereço que não existe.
            anunciado = urllib.parse.urlparse(meta["resource"]).netloc
            se_esperava = urllib.parse.urlparse(base).netloc
            if anunciado != se_esperava:
                raise Falha(
                    f"o servidor anuncia {meta['resource']}, mas estamos falando com {base}. "
                    "O BASE_URL do Cloud Run está errado e o connector do Claude vai falhar."
                )

    print("\n2. /mcp sem credencial precisa recusar")
    st, cab, _ = pedir(base, "POST", "/mcp", "{}", {"Content-Type": "application/json"})
    if st != 401:
        raise Falha(f"esperado 401, veio {st} — o endpoint pode estar aberto")
    desafio = cab.get("www-authenticate", "")
    if "resource_metadata=" not in desafio:
        raise Falha(
            "o 401 veio sem WWW-Authenticate apontando o resource_metadata. "
            "É por esse header que o Claude descobre como se autenticar."
        )
    ok(f"401 com WWW-Authenticate: {desafio[:60]}...")

    print("\n3. Fluxo de autorização com PKCE")
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    estado = secrets.token_urlsafe(8)

    comum = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "state": estado,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "scope": "imagegen",
    }

    st, _, corpo = pedir(base, "GET", "/authorize?" + urllib.parse.urlencode(comum))
    if st != 200:
        raise Falha(f"GET /authorize respondeu {st}: {corpo[:200].decode('utf-8', 'replace')}")
    ok("tela de autorização carregou")

    st, _, _ = pedir(
        base, "POST", "/authorize",
        urllib.parse.urlencode({**comum, "senha": "senha-propositalmente-errada"}),
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if st != 401:
        raise Falha(f"senha errada devia dar 401, veio {st}")
    ok("senha errada recusada")

    st, cab, _ = pedir(
        base, "POST", "/authorize",
        urllib.parse.urlencode({**comum, "senha": senha}),
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if st != 302:
        raise Falha(
            f"senha correta devia redirecionar (302), veio {st}. "
            "Confira se o segredo oauth-senha tem mesmo o valor que você digitou."
        )
    if "location" not in cab:
        raise Falha(f"o 302 veio sem header Location. Headers recebidos: {sorted(cab)}")
    destino = urllib.parse.parse_qs(urllib.parse.urlparse(cab["location"]).query)
    if destino.get("state", [None])[0] != estado:
        raise Falha("o state não voltou igual")
    code = destino["code"][0]
    ok("autorização concedida")

    st, _, corpo = pedir(
        base, "POST", "/token",
        urllib.parse.urlencode({
            "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
            "code_verifier": verifier, "client_id": client_id, "client_secret": client_secret,
        }),
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if st != 200:
        raise Falha(f"/token respondeu {st}: {corpo[:200].decode('utf-8', 'replace')}")
    token = json.loads(corpo)["access_token"]
    ok("access token emitido")

    auth = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + token,
    }

    def mcp(metodo, params=None, ident=1):
        pedido = {"jsonrpc": "2.0", "id": ident, "method": metodo}
        if params is not None:
            pedido["params"] = params
        st, _, corpo = pedir(base, "POST", "/mcp", json.dumps(pedido), auth)
        if st != 200:
            raise Falha(f"{metodo} respondeu HTTP {st}: {corpo[:300].decode('utf-8', 'replace')}")
        texto = corpo.decode("utf-8", "replace")
        # resposta pode vir como SSE (event: message / data: {...}) ou JSON puro
        for linha in texto.splitlines():
            if linha.startswith("data: "):
                return json.loads(linha[6:])
        return json.loads(texto)

    print("\n4. Ferramentas registradas")
    resp = mcp("tools/list")
    nomes = [t["name"] for t in resp["result"]["tools"]]
    ok(f"{nomes}")
    if "gerar_imagem" not in nomes:
        raise Falha("gerar_imagem não apareceu na lista")

    print("\n5. estimar_custo (não gasta nada)")
    resp = mcp("tools/call", {"name": "estimar_custo",
                              "arguments": {"finalidade": "rascunho", "quantidade": 10}}, 2)
    print("      " + resp["result"]["content"][0]["text"].replace("\n", "\n      "))

    if not gerar:
        print("\n(teste de geração pulado)")
        return 0

    print("\n6. Geração real — um rascunho, ~US$ 0,003")
    resp = mcp("tools/call", {
        "name": "gerar_imagem",
        "arguments": {
            "prompt": "Interior de um centro de distribuição moderno visto da doca de "
                      "expedição, esteiras com caixas, luz dura entrando pelas portas",
            "finalidade": "rascunho",
            "formato": "horizontal",
            "marca": True,
        },
    }, 3)
    resultado = resp.get("result", {})
    if resultado.get("isError"):
        raise Falha("gerar_imagem devolveu erro:\n      " +
                    resultado["content"][0]["text"].replace("\n", "\n      "))

    destino_arquivo = None
    for parte in resultado.get("content", []):
        if parte["type"] == "image":
            destino_arquivo = os.path.expanduser("~/teste-imagegen.png")
            with open(destino_arquivo, "wb") as f:
                f.write(base64.b64decode(parte["data"]))
        elif parte["type"] == "text":
            print("      " + parte["text"].replace("\n", "\n      "))
    if destino_arquivo:
        ok(f"imagem salva em {destino_arquivo} "
           f"({os.path.getsize(destino_arquivo) // 1024} KB)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Falha as e:
        erro(str(e))
        sys.exit(1)

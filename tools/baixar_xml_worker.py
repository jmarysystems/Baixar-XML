"""Worker do GitHub Actions: processa a fila xml_pedidos baixando da SEFAZ.

Roda no GitHub Actions com a chave service_role em secret. Nunca precisa do
certificado em disco: baixa do bucket privado e lê a senha do Vault.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    pkcs12,
)

SUPA = os.environ.get("SUPABASE_URL", "https://cowbpaaaguylhlvnlaac.supabase.co")
SERVICE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ENDPOINT = "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx"

CABECALHO = """<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                 xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                 xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
{dados}
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>"""

MOLDE_NSU = """        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>{tp_amb}</tpAmb>
          <cUFAutor>{cuf}</cUFAutor>
          <CNPJ>{cnpj}</CNPJ>
          <distNSU><ultNSU>{ult_nsu}</ultNSU></distNSU>
        </distDFeInt>"""


def api(caminho, metodo="GET", corpo=None, bruto=False):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(
        SUPA + caminho, data=dados, method=metodo,
        headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}",
                 "Content-Type": "application/json",
                 "Prefer": "return=representation"})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            conteudo = resp.read()
            if bruto:
                return resp.status, conteudo
            texto = conteudo.decode()
            return resp.status, (json.loads(texto) if texto else None)
    except urllib.error.HTTPError as exc:
        texto = exc.read().decode()
        try:
            return exc.code, json.loads(texto)
        except json.JSONDecodeError:
            return exc.code, texto


def pegar_pendente():
    st, r = api("/rest/v1/xml_pedidos?status=eq.pendente&order=criado_em&limit=1")
    if st == 200 and r:
        pedido = r[0]
        st2, _ = api(f"/rest/v1/xml_pedidos?id=eq.{pedido['id']}",
                     "PATCH", {"status": "processando", "iniciado_em": agora()})
        if st2 < 300:
            return pedido
    return None


def agora():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def marcar(pedido_id, status, mensagem=None, documentos=None):
    corpo = {"status": status, "fim_em": agora()}
    if mensagem is not None:
        corpo["mensagem"] = mensagem[:500]
    if documentos is not None:
        corpo["documentos"] = documentos
    api(f"/rest/v1/xml_pedidos?id=eq.{pedido_id}", "PATCH", corpo)


def baixar_certificado(loja_id):
    st, loja = api(f"/rest/v1/arm_lojas?select=certificado_caminho&id=eq.{loja_id}")
    if st != 200 or not loja:
        raise RuntimeError("estabelecimento não encontrado")
    caminho = loja[0].get("certificado_caminho")
    if not caminho:
        raise RuntimeError("estabelecimento sem certificado")

    st, conteudo = api(f"/storage/v1/object/certificados/{caminho}", bruto=True)
    if st != 200:
        raise RuntimeError(f"certificado indisponível ({st})")

    st, senha = api("/rest/v1/rpc/certificado_senha_ler", "POST", {"p_loja_id": loja_id})
    if st != 200 or not senha:
        raise RuntimeError("senha do certificado não está no cofre")
    return conteudo, senha


def contexto_tls(pfx: bytes, senha: str) -> ssl.SSLContext:
    chave, cert, extras = pkcs12.load_key_and_certificates(pfx, senha.encode())
    if chave is None or cert is None:
        raise RuntimeError("certificado inválido")

    cadeia = [cert] + list(extras or [])
    with tempfile.TemporaryDirectory() as tmp:
        cert_path = Path(tmp) / "cert.pem"
        key_path = Path(tmp) / "key.pem"
        cert_path.write_text(
            "".join(c.public_bytes(Encoding.PEM).decode() for c in cadeia), encoding="utf-8")
        key_path.write_text(
            chave.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode(),
            encoding="utf-8")

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    return ctx


def consultar(ctx, cnpj, ult_nsu, tp_amb, cuf):
    dados = MOLDE_NSU.format(tp_amb=tp_amb, cuf=cuf, cnpj=cnpj, ult_nsu=ult_nsu.zfill(15))
    corpo = CABECALHO.format(dados=dados).encode()
    req = urllib.request.Request(
        ENDPOINT, data=corpo, method="POST",
        headers={"Content-Type": "application/soap+xml; charset=utf-8",
                 "SOAPAction":
                     "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"})
    with urllib.request.urlopen(req, context=ctx, timeout=90) as resp:
        return resp.read().decode("utf-8", "replace")


def extrair(resposta):
    docs = []
    for bloco in re.findall(r"<docZip[^>]*>[^<]+</docZip>", resposta):
        nsu = re.search(r'NSU="(\d+)"', bloco)
        schema = re.search(r'schema="([^"]+)"', bloco)
        conteudo = re.sub(r"<[^>]+>", "", bloco).strip()
        try:
            xml = gzip.decompress(base64.b64decode(conteudo)).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            continue
        chave = re.search(r'Id="NFe(\d{44})"', xml)
        docs.append({
            "nsu": nsu.group(1) if nsu else None,
            "schema": schema.group(1) if schema else None,
            "chave": chave.group(1) if chave else None,
            "tipo": "NF-e" if (schema and schema.group(1).startswith("procNFe"))
                    else (schema.group(1) if schema else "documento"),
            "xml": xml,
        })
    return docs


def gravar(loja_id, cnpj, docs):
    if not docs:
        return 0
    corpo = [{"loja_id": loja_id, "cnpj": cnpj, **d} for d in docs]
    st, _ = api("/rest/v1/xml_baixados?on_conflict=cnpj,chave", "POST", corpo)
    if st >= 300:
        return 0
    return len(corpo)


def processar(pedido):
    pfx, senha = baixar_certificado(pedido["loja_id"])
    ctx = contexto_tls(pfx, senha)

    ult = (pedido.get("ult_nsu") or "0").zfill(15)
    total = 0
    tentativas_656 = 0

    for rodada in range(1, 40):
        resposta = consultar(ctx, pedido["cnpj"], ult, pedido.get("tp_amb", "1"),
                             pedido.get("cuf", "23"))
        cstat = re.search(r"<cStat>(\d+)</cStat>", resposta)
        cstat = cstat.group(1) if cstat else "?"

        if cstat == "656":
            tentativas_656 += 1
            if tentativas_656 > 3:
                raise RuntimeError("SEFAZ bloqueou as consultas (cStat 656). Tente mais tarde.")
            time.sleep(90 * tentativas_656)
            continue

        docs = extrair(resposta)
        if docs:
            total += gravar(pedido["loja_id"], pedido["cnpj"], docs)
            print(f"  rodada {rodada}: {len(docs)} documentos (total {total})")

        novo = re.search(r"<ultNSU>(\d+)</ultNSU>", resposta)
        maximo = re.search(r"<maxNSU>(\d+)</maxNSU>", resposta)
        if not docs or not novo:
            break
        if maximo and novo.group(1) == maximo.group(1):
            break
        ult = novo.group(1)
        time.sleep(20)

    return total


def main():
    processados = 0
    for _ in range(5):
        pedido = pegar_pendente()
        if not pedido:
            break
        print(f"pedido {pedido['id']} | CNPJ {pedido['cnpj']}")
        try:
            total = processar(pedido)
            marcar(pedido["id"], "concluido", f"{total} documento(s) baixado(s)", total)
            print(f"  concluído com {total} documentos")
        except Exception as exc:  # noqa: BLE001
            marcar(pedido["id"], "erro", str(exc))
            print(f"  erro: {exc}")
        processados += 1

    print(f"pedidos processados: {processados}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

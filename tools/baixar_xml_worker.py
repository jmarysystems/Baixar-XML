"""Worker do GitHub Actions: processa a fila xml_pedidos baixando da SEFAZ.

Regras importantes:
  • retoma de onde parou (guarda o último NSU no próprio pedido);
  • não duplica documentos (confere NSU já gravado);
  • ao receber 656 devolve o pedido para a fila em vez de falhar;
  • espera entre lotes para não estourar o limite da SEFAZ.
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

LOTES_POR_EXECUCAO = 3      # quantos lotes de 50 por rodada do workflow
ESPERA_ENTRE_LOTES = 45     # segundos entre lotes

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


def agora():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def api(caminho, metodo="GET", corpo=None, bruto=False):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(
        SUPA + caminho, data=dados, method=metodo,
        headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}",
                 "Content-Type": "application/json",
                 "Prefer": "return=representation"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
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


def atualizar_pedido(pedido_id, **campos):
    campos.setdefault("fim_em", agora())
    api(f"/rest/v1/xml_pedidos?id=eq.{pedido_id}", "PATCH", campos)


def usuario_para(pedido_id):
    st, r = api(f"/rest/v1/xml_pedidos?select=criado_por&id=eq.{pedido_id}")
    if st == 200 and r:
        return r[0].get("criado_por")
    return None


def baixar_certificado(loja_id):
    st, loja = api(f"/rest/v1/arm_lojas?select=certificado_caminho&id=eq.{loja_id}")
    if st != 200 or not loja:
        raise RuntimeError("estabelecimento não encontrado")
    caminho = loja[0].get("certificado_caminho")
    if not caminho:
        raise RuntimeError("estabelecimento sem certificado digital")

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


def nsus_gravados(cnpj):
    st, r = api(f"/rest/v1/xml_baixados?select=nsu&cnpj=eq.{cnpj}&chave=not.is.null"
                if False else f"/rest/v1/xml_baixados?select=nsu&cnpj=eq.{cnpj}")
    if st == 200 and r:
        return {linha["nsu"] for linha in r if linha.get("nsu")}
    return set()


def maior_nsu(cnpj):
    st, r = api(f"/rest/v1/xml_baixados?select=nsu&cnpj=eq.{cnpj}"
                "&order=nsu.desc&limit=1")
    if st == 200 and r and r[0].get("nsu"):
        return r[0]["nsu"]
    return None


def gravar(loja_id, cnpj, docs, ja_existem, criado_por):
    novos = [d for d in docs if d.get("nsu") not in ja_existem]
    if not novos:
        return 0
    corpo = [{"loja_id": loja_id, "cnpj": cnpj, "criado_por": criado_por, **d}
             for d in novos]
    st, _ = api("/rest/v1/xml_baixados?on_conflict=cnpj,chave", "POST", corpo)
    if st >= 300:
        print(f"    falha ao gravar: {st}")
        return 0
    ja_existem.update(d["nsu"] for d in novos if d.get("nsu"))
    return len(novos)


def processar(pedido):
    pfx, senha = baixar_certificado(pedido["loja_id"])
    ctx = contexto_tls(pfx, senha)

    cnpj = pedido["cnpj"]
    ja_existem = nsus_gravados(cnpj)
    criado_por = usuario_para(pedido["id"])

    ult = (pedido.get("ult_nsu") or "0").zfill(15)
    if ult == "0" * 15:
        salvo = maior_nsu(cnpj)
        if salvo:
            ult = salvo.zfill(15)
            print(f"  retomando do NSU {ult}")

    total = 0
    for lote in range(1, LOTES_POR_EXECUCAO + 1):
        resposta = consultar(ctx, cnpj, ult, pedido.get("tp_amb", "1"), pedido.get("cuf", "23"))

        cstat = re.search(r"<cStat>(\d+)</cStat>", resposta)
        cstat = cstat.group(1) if cstat else "?"
        motivo = re.search(r"<xMotivo>([^<]+)</xMotivo>", resposta)

        if cstat == "656":
            print("  SEFAZ bloqueou (656) — devolvendo para a fila")
            atualizar_pedido(pedido["id"], status="pendente", ult_nsu=ult,
                             mensagem="Aguardando o limite da SEFAZ liberar")
            return total, True

        docs = extrair(resposta)
        if docs:
            gravados = gravar(pedido["loja_id"], cnpj, docs, ja_existem, criado_por)
            total += gravados
            print(f"  lote {lote}: {len(docs)} recebidos, {gravados} novos (total {total})")

        novo = re.search(r"<ultNSU>(\d+)</ultNSU>", resposta)
        maximo = re.search(r"<maxNSU>(\d+)</maxNSU>", resposta)

        if not docs or not novo:
            print(f"  sem documentos novos (cStat {cstat}"
                  f"{' - ' + motivo.group(1) if motivo else ''})")
            return total, False

        ult = novo.group(1)
        atualizar_pedido(pedido["id"], ult_nsu=ult, status="processando",
                         documentos=total, mensagem=f"em andamento ({total} documentos)")

        if maximo and ult == maximo.group(1):
            print("  chegou ao último NSU disponível")
            return total, False

        if lote < LOTES_POR_EXECUCAO:
            print(f"  aguardando {ESPERA_ENTRE_LOTES}s…")
            time.sleep(ESPERA_ENTRE_LOTES)

    print("  fim do lote desta execução — continua na próxima")
    atualizar_pedido(pedido["id"], status="pendente", ult_nsu=ult,
                     documentos=total, mensagem=f"continua na próxima execução ({total} até agora)")
    return total, True


def main():
    processados = 0
    for _ in range(2):
        pedido = pegar_pendente()
        if not pedido:
            break
        print(f"pedido {pedido['id']} | CNPJ {pedido['cnpj']}")
        try:
            total, continua = processar(pedido)
            if not continua:
                atualizar_pedido(pedido["id"], status="concluido", documentos=total,
                                 mensagem=f"{total} documento(s) baixado(s)")
            print(f"  fim: {total} documentos | continua={continua}")
        except Exception as exc:  # noqa: BLE001
            atualizar_pedido(pedido["id"], status="erro", mensagem=str(exc))
            print(f"  erro: {exc}")
        processados += 1

    print(f"pedidos processados: {processados}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

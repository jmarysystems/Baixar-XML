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

from cryptography.hazmat.primitives import serialization
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

ENDPOINT_EVENTO = "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx"

MOLDE_EVENTO = """<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <infEvento Id="ID{tp_evento}{chave}{seq:02d}">
    <cOrgao>{cuf}</cOrgao>
    <tpAmb>{tp_amb}</tpAmb>
    <CNPJ>{cnpj}</CNPJ>
    <chNFe>{chave}</chNFe>
    <dhEvento>{dh_evento}</dhEvento>
    <tpEvento>{tp_evento}</tpEvento>
    <nSeqEvento>{seq}</nSeqEvento>
    <verEvento>1.00</verEvento>
    <detEvento versao="1.00">
      <descEvento>{descricao}</descEvento>
    </detEvento>
  </infEvento>
</evento>"""

ENVELOPE_EVENTO = """<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeRecepcaoEvento xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">
      <nfeDadosMsg>{evento}</nfeDadosMsg>
    </nfeRecepcaoEvento>
  </soap12:Body>
</soap12:Envelope>"""

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

MOLDE_CHAVE = """        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>{tp_amb}</tpAmb>
          <cUFAutor>{cuf}</cUFAutor>
          <CNPJ>{cnpj}</CNPJ>
          <consChNFe><chNFe>{chave}</chNFe></consChNFe>
        </distDFeInt>"""

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


def pegar_pendente(ja_processados=None):
    ja_processados = ja_processados or set()
    st, r = api("/rest/v1/xml_pedidos?status=eq.pendente&order=criado_em&limit=5")
    if st == 200 and r:
        r = [p for p in r if p["id"] not in ja_processados]
        if not r:
            return None
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



def chaves_pem(pfx: bytes, senha: str) -> tuple[str, str]:
    """Devolve (chave_privada_pem, certificado_pem_com_cadeia)."""
    chave, cert, extras = pkcs12.load_key_and_certificates(pfx, senha.encode())
    if chave is None or cert is None:
        raise RuntimeError("certificado inválido")

    cadeia = [cert] + list(extras or [])
    cert_pem = "".join(c.public_bytes(Encoding.PEM).decode() for c in cadeia)
    chave_pem = chave.private_bytes(
        Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
    return chave_pem, cert_pem


def contexto_tls_raw(chave_pem: str, cert_pem: str) -> ssl.SSLContext:
    """Contexto TLS com o certificado em memória (PEM)."""
    with tempfile.TemporaryDirectory() as tmp:
        cert_path = Path(tmp) / "cert.pem"
        key_path = Path(tmp) / "key.pem"
        cert_path.write_text(cert_pem, encoding="utf-8")
        key_path.write_text(chave_pem, encoding="utf-8")

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    return ctx


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


def consultar(ctx, cnpj, ult_nsu, tp_amb, cuf, chave=None):
    if chave:
        dados = MOLDE_CHAVE.format(tp_amb=tp_amb, cuf=cuf, cnpj=cnpj, chave=chave)
    else:
        dados = MOLDE_NSU.format(tp_amb=tp_amb, cuf=cuf, cnpj=cnpj,
                                 ult_nsu=ult_nsu.zfill(15))
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
        chave = (re.search(r'Id="NFe(\d{44})"', xml)
                 or re.search(r"<chNFe>(\d{44})</chNFe>", xml))
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
    st, _ = api("/rest/v1/xml_baixados", "POST", corpo)
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

    chave_pedido = (pedido.get("chave") or "").strip() or None
    if chave_pedido:
        print(f"  consulta pela chave {chave_pedido}")
        resposta = consultar(ctx, cnpj, ult, pedido.get("tp_amb", "1"),
                             pedido.get("cuf", "23"), chave_pedido)
        cstat = re.search(r"<cStat>(\d+)</cStat>", resposta)
        cstat = cstat.group(1) if cstat else "?"
        motivo = re.search(r"<xMotivo>([^<]+)</xMotivo>", resposta)

        if cstat == "656":
            print("  SEFAZ bloqueou (656) — devolvendo para a fila")
            atualizar_pedido(pedido["id"], status="pendente",
                             mensagem="Aguardando o limite da SEFAZ liberar")
            return 0, True

        docs = extrair(resposta)
        gravados = gravar(pedido["loja_id"], cnpj, docs, ja_existem, criado_por) if docs else 0
        print(f"  chave: {len(docs)} documento(s), {gravados} novo(s) "
              f"(cStat {cstat}{' - ' + motivo.group(1) if motivo else ''})")
        return gravados, False

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
        pedido["_ult_nsu"] = ult
        atualizar_pedido(pedido["id"], ult_nsu=ult, status="processando",
                         documentos=total, mensagem=f"em andamento ({total} documentos)")

        if pedido.get("origem") == "auto":
            salvar_config(ult_nsu=ult)

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


def ler_config():
    st, r = api("/rest/v1/xml_config?select=*&id=eq.true")
    if st == 200 and r:
        return r[0]
    return None


def salvar_config(**campos):
    campos["atualizado_em"] = agora()
    api("/rest/v1/xml_config?id=eq.true", "PATCH", campos)


def agendar_automatico(cfg):
    """Se o modo automático está ligado, garante um pedido na fila."""
    if not cfg or not cfg.get("automatico") or not cfg.get("loja_id"):
        return None

    st, ativos = api("/rest/v1/xml_pedidos?status=in.(pendente,processando)"
                     "&origem=eq.auto&limit=1")
    if st == 200 and ativos:
        return None

    corpo = [{
        "loja_id": cfg["loja_id"],
        "cnpj": cfg.get("cnpj"),
        "ult_nsu": cfg.get("ult_nsu") or "0",
        "tp_amb": cfg.get("tp_amb", "1"),
        "cuf": cfg.get("cuf", "23"),
        "origem": "auto",
        "status": "pendente",
    }]
    st, r = api("/rest/v1/xml_pedidos", "POST", corpo)
    if st < 300:
        print(f"  pedido automático criado (NSU {corpo[0]['ult_nsu']})")
        return r[0] if isinstance(r, list) else None
    return None


def atualizar_config_pos_pedido(pedido):
    cfg = ler_config()
    if not cfg:
        return
    novo_ult = pedido.get("_ult_nsu") or cfg.get("ult_nsu") or "0"
    salvar_config(ult_nsu=novo_ult)



def assinar_evento(evento_xml: str, chave_pem: str, cert_pem: str) -> str:
    """Assina o infEvento (XMLDSig enveloped, SHA-1 como no manual da NF-e)."""
    from lxml import etree
    from signxml import XMLSigner, methods

    raiz = etree.fromstring(evento_xml.encode("utf-8"))
    inf = raiz.find("{http://www.portalfiscal.inf.br/nfe}infEvento")
    id_evento = inf.get("Id")

    assinador = XMLSigner(
        method=methods.enveloped,
        signature_algorithm="rsa-sha1",
        digest_algorithm="sha1",
        c14n_algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    )
    assinado = assinador.sign(inf, key=chave_pem, cert=cert_pem, reference_uri=id_evento)
    return etree.tostring(raiz, encoding="unicode")


def enviar_evento(ctx, evento_assinado: str) -> str:
    corpo = ENVELOPE_EVENTO.format(evento=evento_assinado).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT_EVENTO, data=corpo, method="POST",
        headers={"Content-Type": "application/soap+xml; charset=utf-8",
                 "SOAPAction":
                     "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento"})
    with urllib.request.urlopen(req, context=ctx, timeout=90) as resp:
        return resp.read().decode("utf-8", "replace")


def manifestar(pedido, ctx, chave_pem, cert_pem):
    """Envia a Ciência da Emissão e devolve (ok, mensagem)."""
    chave = (pedido.get("chave") or "").strip()
    if len(chave) != 44:
        return False, "chave inválida para manifestar"

    dh = time.strftime("%Y-%m-%dT%H:%M:%S-03:00", time.localtime())
    evento = MOLDE_EVENTO.format(
        tp_evento="210210", chave=chave, seq=1, cuf=pedido.get("cuf", "23"),
        tp_amb=pedido.get("tp_amb", "1"), cnpj=pedido["cnpj"], dh_evento=dh,
        descricao="Ciencia da Emissao",
    )

    assinado = assinar_evento(evento, chave_pem, cert_pem)
    resposta = enviar_evento(ctx, assinado)

    cstat = re.search(r"<cStat>(\d+)</cStat>", resposta)
    motivo = re.search(r"<xMotivo>([^<]+)</xMotivo>", resposta)
    codigo = cstat.group(1) if cstat else "?"

    if codigo in {"128", "135", "573"}:
        return True, f"manifestação registrada (cStat {codigo})"
    if codigo == "656":
        return None, "SEFAZ bloqueou (656)"
    return False, f"cStat {codigo} - {motivo.group(1) if motivo else 'sem motivo'}"


def main():
    processados = 0
    vistos = set()

    cfg = ler_config()
    if cfg and cfg.get("automatico"):
        print(f"modo automático ligado (NSU {cfg.get('ult_nsu')})")
        agendar_automatico(cfg)

    for _ in range(3):
        pedido = pegar_pendente(vistos)
        if pedido:
            vistos.add(pedido["id"])
        if not pedido:
            break
        acao = pedido.get("acao") or "baixar"
        print(f"pedido {pedido['id']} | CNPJ {pedido['cnpj']} | ação {acao}")
        try:
            if acao == "manifestar":
                pfx, senha_cert = baixar_certificado(pedido["loja_id"])
                chave_p, cert_p = chaves_pem(pfx, senha_cert)
                ctx_http = contexto_tls_raw(cert_p, chave_p)
                ok, msg = manifestar(pedido, ctx_http, chave_p, cert_p)

                if ok is None:
                    atualizar_pedido(pedido["id"], status="pendente", mensagem=msg)
                    continue
                if not ok:
                    atualizar_pedido(pedido["id"], status="erro", mensagem=msg)
                    continue

                # manifestou: busca o XML completo pela chave
                resposta = consultar(ctx_http, pedido["cnpj"], "0",
                                     pedido.get("tp_amb", "1"), pedido.get("cuf", "23"),
                                     pedido.get("chave"))
                docs = extrair(resposta)
                ja_existem = nsus_gravados(pedido["cnpj"])
                gravados = gravar(pedido["loja_id"], pedido["cnpj"], docs, ja_existem,
                                  usuario_para(pedido["id"])) if docs else 0
                atualizar_pedido(pedido["id"], status="concluido", documentos=gravados,
                                 mensagem=f"{msg}; {gravados} documento(s) completo(s)")
                print(f"  {msg} | XML completo: {gravados}")
                processados += 1
                continue

            total, continua = processar(pedido)
            if not continua:
                atualizar_pedido(pedido["id"], status="concluido", documentos=total,
                                 mensagem=f"{total} documento(s) baixado(s)")
                if pedido.get("origem") == "auto":
                    atualizar_config_pos_pedido(pedido)
            print(f"  fim: {total} documentos | continua={continua}")
        except Exception as exc:  # noqa: BLE001
            atualizar_pedido(pedido["id"], status="erro", mensagem=str(exc))
            print(f"  erro: {exc}")
        processados += 1

    print(f"pedidos processados: {processados}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

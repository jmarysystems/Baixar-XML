// =====================================================================
// baixar-xml — consulta o NFeDistribuicaoDFe da SEFAZ
//
// IMPORTANTE: a SEFAZ exige TLS mútuo (certificado do cliente). O runtime
// das Edge Functions só consegue isso se `Deno.createHttpClient` estiver
// disponível; quando não estiver, a função responde explicando que a
// consulta precisa ser feita por um host com o certificado (o script
// tools/baixar_xml_sefaz.py roda no seu computador e cumpre o papel).
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ENDPOINT =
  "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";

function envelope(cnpj: string, ultNsu: string, tpAmb: string, cUF: string, chave?: string | null) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>${tpAmb}</tpAmb>
          <cUFAutor>${cUF}</cUFAutor>
          <CNPJ>${cnpj}</CNPJ>
          ${chave ? `<consChNFe><chNFe>${chave}</chNFe></consChNFe>`
                 : `<distNSU><ultNSU>${ultNsu.padStart(15, "0")}</ultNSU></distNSU>`}
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);

  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ erro: "Não autenticado." }, 401);

    const clienteUsuario = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });

    const { data: { user } } = await clienteUsuario.auth.getUser();
    if (!user) return json({ erro: "Sessão inválida." }, 401);

    const { data: pode } = await clienteUsuario.rpc("pode_no_modulo", {
      p_modulo: "xml",
      p_acao: "cadastrar",
    });
    if (!pode) return json({ erro: "Sem permissão para baixar XML." }, 403);

    const corpo = await req.json().catch(() => null);
    const lojaId: string | undefined = corpo?.loja_id;
    const cnpj = String(corpo?.cnpj ?? "").replace(/\D/g, "");
    const ultNsu = String(corpo?.ult_nsu ?? "0").replace(/\D/g, "") || "0";
    const tpAmb = String(corpo?.tp_amb ?? "1");
    const cuf = String(corpo?.cuf ?? "23").replace(/\D/g, "").slice(0, 2) || "23";

    const chave = String(corpo?.chave ?? "").replace(/\D/g, "") || null;

    if (!lojaId || cnpj.length !== 14) return json({ erro: "Informe loja_id e CNPJ." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: loja, error: erroLoja } = await admin
      .from("arm_lojas")
      .select("id, nome, certificado_caminho, certificado_validade, ambiente")
      .eq("id", lojaId)
      .single();

    if (erroLoja || !loja?.certificado_caminho) {
      return json({ erro: "Estabelecimento sem certificado digital." }, 400);
    }

    const { data: arquivo } = await admin.storage
      .from("certificados")
      .download(loja.certificado_caminho);

    const { data: senha } = await admin.rpc("certificado_senha_ler", { p_loja_id: lojaId });
    if (!arquivo || !senha) {
      return json({ erro: "Certificado ou senha não encontrados no cofre." }, 400);
    }

    // ---------------------------------------------------------- abre o .pfx
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);

    let p12: forge.pkcs12.Pkcs12Pfx;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(bin), senha as string);
    } catch {
      return json({ erro: "Senha do certificado incorreta." }, 400);
    }

    const chaves = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] || [];
    const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[
      forge.pki.oids.certBag
    ] || [];

    if (!chaves.length || !certs.length) return json({ erro: "Certificado inválido." }, 400);

    const chavePem = forge.pki.privateKeyToPem(chaves[0].key);
    const certPem = forge.pki.certificateToPem(certs[0].cert);

    // ---------------------------------------------------------- TLS mútuo
    const criarCliente = (Deno as unknown as {
      createHttpClient?: (opcoes: unknown) => unknown;
    }).createHttpClient;

    if (typeof criarCliente !== "function") {
      return json({
        erro:
          "Este runtime não suporta certificado de cliente (TLS mútuo). " +
          "Use o script tools/baixar_xml_sefaz.py no computador que tem o certificado.",
        precisa_cliente_local: true,
      }, 501);
    }

    // A SEFAZ só aceita HTTP/1.1: desliga o HTTP/2 no cliente TLS
    let cliente: unknown;
    let http11 = true;
    try {
      cliente = criarCliente.call(Deno, { cert: certPem, key: chavePem, http2: false });
    } catch {
      http11 = false;
      cliente = criarCliente.call(Deno, { cert: certPem, key: chavePem });
    }

    const soap = envelope(cnpj, ultNsu, tpAmb, cuf, chave);
    const resposta = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
        "SOAPAction": "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse",
      },
      body: soap,
      // @ts-ignore: client TLS é extensão do Deno, fora do tipo padrão
      client: cliente,
    });

    const texto = await resposta.text();
    if (!resposta.ok) {
      return json({
        erro: `SEFAZ respondeu ${resposta.status}`,
        detalhe: texto.slice(0, 500),
        http11,
      }, 502);
    }

    // ---------------------------------------------------------- parse
    const documentos: unknown[] = [];
    const blocos = texto.match(/<docZip[^>]*>[^<]+<\/docZip>/g) || [];
    const ultimoNsu = /<ultNSU>(\d+)<\/ultNSU>/.exec(texto)?.[1] ?? ultNsu;

    for (const bloco of blocos) {
      const nsu = /NSU="(\d+)"/.exec(bloco)?.[1] ?? null;
      const schema = /schema="([^"]+)"/.exec(bloco)?.[1] ?? null;
      const base64 = bloco.replace(/<[^>]+>/g, "").trim();

      try {
        const comprimido = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const fluxo = new Blob([comprimido]).stream()
          .pipeThrough(new DecompressionStream("gzip"));
        const xml = await new Response(fluxo).text();

        documentos.push({
          nsu,
          schema,
          tipo: schema?.startsWith("procNFe") ? "NF-e" : (schema ?? "documento"),
          chave: /Id="NFe(\d{44})"/.exec(xml)?.[1] ?? /(\d{44})/.exec(schema ?? "")?.[1] ?? null,
          xml,
        });
      } catch {
        // documento ilegível: ignora
      }
    }

    return json({ ok: true, ult_nsu: ultimoNsu, documentos });
  } catch (erro) {
    console.error(erro);
    const mensagem = String((erro as Error)?.message ?? erro);
    if (/HTTP\/1\.1|http2/i.test(mensagem)) {
      return json({
        erro:
          "A SEFAZ recusa HTTP/2 e este runtime insistiu nele. " +
          "Use o script baixar_xml_sefaz.py no computador com o certificado.",
        detalhe: mensagem.slice(0, 300),
      }, 500);
    }
    return json({ erro: mensagem }, 500);
  }
});

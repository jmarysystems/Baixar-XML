// =====================================================================
// baixar-xml (v5) — consulta o NFeDistribuicaoDFe da SEFAZ
//
// • Certificado e senha vêm do bucket privado + Vault (nunca do app)
// • TLS mútuo com a cadeia completa de certificados
// • Responde sempre JSON; inclui "versao" para conferir o que está no ar
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSAO = "v5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const responder = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify({ versao: VERSAO, ...(corpo as object) }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const ENDPOINT =
  "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";

function montarEnvelope(
  cnpj: string,
  ultNsu: string,
  tpAmb: string,
  cuf: string,
  chave: string | null,
): string {
  const consulta = chave
    ? `<consChNFe><chNFe>${chave}</chNFe></consChNFe>`
    : `<distNSU><ultNSU>${ultNsu.padStart(15, "0")}</ultNSU></distNSU>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                 xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                 xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
      <nfeDadosMsg>
        <distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
          <tpAmb>${tpAmb}</tpAmb>
          <cUFAutor>${cuf}</cUFAutor>
          <CNPJ>${cnpj}</CNPJ>
          ${consulta}
        </distDFeInt>
      </nfeDadosMsg>
    </nfeDistDFeInteresse>
  </soap12:Body>
</soap12:Envelope>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return responder({ erro: "Use POST." }, 405);
  if (req.method === "GET") return responder({ ok: true, versao: VERSAO });

  let certificadosNaCadeia = 0;

  try {
    // ---------------------------------------------------------- acesso
    if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
      return responder({
        erro: "Configuração incompleta: falta SUPABASE_SERVICE_ROLE_KEY.",
      }, 500);
    }

    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return responder({ erro: "Não autenticado." }, 401);

    const comoUsuario = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });

    const { data: usuario } = await comoUsuario.auth.getUser();
    if (!usuario?.user) return responder({ erro: "Sessão inválida." }, 401);

    const { data: pode } = await comoUsuario.rpc("pode_no_modulo", {
      p_modulo: "xml",
      p_acao: "cadastrar",
    });
    if (!pode) return responder({ erro: "Sem permissão para baixar XML." }, 403);

    // ---------------------------------------------------------- entrada
    const corpo = await req.json().catch(() => null);
    const lojaId = String(corpo?.loja_id ?? "");
    const cnpj = String(corpo?.cnpj ?? "").replace(/\D/g, "");
    const ultNsu = String(corpo?.ult_nsu ?? "0").replace(/\D/g, "") || "0";
    const tpAmb = String(corpo?.tp_amb ?? "1");
    const cuf = (String(corpo?.cuf ?? "23").replace(/\D/g, "") || "23").slice(0, 2);
    const chaveNota = String(corpo?.chave ?? "").replace(/\D/g, "") || null;

    if (!lojaId || cnpj.length !== 14) {
      return responder({ erro: "Informe loja_id e CNPJ." }, 400);
    }

    // ---------------------------------------------------------- certificado
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { data: loja } = await admin
      .from("arm_lojas")
      .select("id, nome, certificado_caminho, certificado_validade")
      .eq("id", lojaId)
      .maybeSingle();

    if (!loja?.certificado_caminho) {
      return responder({ erro: "Estabelecimento sem certificado digital." }, 400);
    }

    const { data: arquivo } = await admin.storage
      .from("certificados")
      .download(loja.certificado_caminho);

    if (!arquivo) return responder({ erro: "Não foi possível ler o certificado." }, 500);

    const { data: senha } = await admin.rpc("certificado_senha_ler", { p_loja_id: lojaId });
    if (!senha) return responder({ erro: "Senha do certificado não está no cofre." }, 400);

    // ---------------------------------------------------------- pfx
    const forge = (await import("npm:node-forge@1.3.1")).default;

    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    let binario = "";
    for (let i = 0; i < bytes.length; i += 1) binario += String.fromCharCode(bytes[i]);

    let p12;
    try {
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binario), senha as string);
    } catch {
      return responder({ erro: "Senha do certificado incorreta." }, 400);
    }

    const bagsChave =
      p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
        forge.pki.oids.pkcs8ShroudedKeyBag
      ] ?? [];
    const bagsCert =
      p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];

    if (!bagsChave.length || !bagsCert.length) {
      return responder({ erro: "Certificado inválido." }, 400);
    }

    const chavePrivada = bagsChave[0].key;
    const chavePem = forge.pki.privateKeyToPem(chavePrivada);

    // cadeia: folha (chave casa com a privada) + intermediários
    const ehFolha = (bag: { cert: { publicKey?: { n?: { equals: (v: unknown) => boolean } } } }) => {
      const pub = bag.cert.publicKey;
      const n = chavePrivada?.n;
      return !!(pub?.n && n && pub.n.equals(n));
    };

    const folha = bagsCert.find(ehFolha) ?? bagsCert[0];
    const cadeia = [folha, ...bagsCert.filter((c) => c !== folha)];
    const certPem = cadeia.map((c) => forge.pki.certificateToPem(c.cert)).join("\n");
    certificadosNaCadeia = cadeia.length;

    // ---------------------------------------------------------- TLS mútuo
    const criarCliente = (Deno as unknown as {
      createHttpClient?: (opcoes: unknown) => unknown;
    }).createHttpClient;

    if (typeof criarCliente !== "function") {
      return responder({
        erro: "Este runtime não suporta certificado de cliente (TLS mútuo).",
        precisa_cliente_local: true,
      }, 501);
    }

    let cliente: unknown;
    try {
      cliente = criarCliente.call(Deno, { cert: certPem, key: chavePem, http2: false });
    } catch {
      cliente = criarCliente.call(Deno, { cert: certPem, key: chavePem });
    }

    // ---------------------------------------------------------- consulta
    const soap = montarEnvelope(cnpj, ultNsu, tpAmb, cuf, chaveNota);
    const inicio = Date.now();

    const resposta = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/soap+xml; charset=utf-8",
        "SOAPAction":
          "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse",
      },
      body: soap,
      // @ts-ignore client TLS é extensão do Deno
      client: cliente,
    });

    const texto = await resposta.text();
    if (!resposta.ok) {
      return responder({
        erro: `SEFAZ respondeu HTTP ${resposta.status}`,
        detalhe: texto.slice(0, 400),
        certificados_na_cadeia: certificadosNaCadeia,
      }, 502);
    }

    // ---------------------------------------------------------- parse
    const documentos: unknown[] = [];
    const blocos = texto.match(/<docZip[^>]*>[^<]+<\/docZip>/g) ?? [];
    const ultimoNsu = /<ultNSU>(\d+)<\/ultNSU>/.exec(texto)?.[1] ?? ultNsu;
    const cStat = /<cStat>(\d+)<\/cStat>/.exec(texto)?.[1] ?? null;
    const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(texto)?.[1] ?? null;

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
          chave: /Id="NFe(\d{44})"/.exec(xml)?.[1] ?? null,
          xml,
        });
      } catch {
        // documento ilegível: ignora
      }
    }

    return responder({
      ok: true,
      cstat: cStat,
      motivo: xMotivo,
      ult_nsu: ultimoNsu,
      certificados_na_cadeia: certificadosNaCadeia,
      milissegundos: Date.now() - inicio,
      documentos,
    });
  } catch (erro) {
    console.error(erro);
    return responder({
      erro: String((erro as Error)?.message ?? erro),
      certificados_na_cadeia: certificadosNaCadeia,
    }, 500);
  }
});

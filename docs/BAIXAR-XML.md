# Baixar XML da SEFAZ — como funciona

O navegador **não consegue** consultar a SEFAZ: o serviço
`NFeDistribuicaoDFe` exige **TLS mútuo** (o certificado do cliente na
conexão). Por isso existem dois caminhos:

## Caminho 1 — script local (funciona hoje)

`tools/baixar_xml_sefaz.py`, rodando no computador que tem o `.pfx`:

```bash
pip install cryptography
python tools/baixar_xml_sefaz.py \
  --pfx "C:\certificados\empresa.pfx" \
  --cnpj 12345678000199 \
  --loja-id <uuid do estabelecimento> \
  --loop
```

O que ele faz:

1. abre o `.pfx` com a senha informada (não grava a senha em lugar nenhum);
2. monta o SOAP do `NFeDistribuicaoDFe` (`distNSU`, `tpAmb`, `CNPJ`);
3. conecta com o certificado no TLS, baixa os `docZip`, descomprime;
4. grava em `xml_baixados` via API do Supabase (com o seu login).

`--loop` continua enquanto houver documentos novos (a SEFAZ devolve até 50
por chamada). `--tp-amb 2` consulta homologação.

## Caminho 2 — Edge Function (quando houver host com mTLS)

`supabase/functions/baixar-xml/index.ts` faz o mesmo pelo servidor:

- valida o JWT e a permissão do módulo **Baixar XML**;
- pega o certificado no bucket privado e a senha no Vault;
- tenta `Deno.createHttpClient({ cert, key })` para o TLS mútuo.

Se o runtime não permitir certificado de cliente, a função responde
`precisa_cliente_local: true` — e o app mostra a orientação para usar o
script. Para publicar: **Edge Functions → Deploy new function → `baixar-xml`**
e cadastrar o secret `SUPABASE_SERVICE_ROLE_KEY`.

## No app

- Escolha o **estabelecimento** (só aparecem os que têm certificado).
- O **CNPJ** vem preenchido do cadastro e pode ser ajustado.
- Informe o **último NSU** (0 na primeira vez) e o ambiente.
- Os documentos baixados ficam listados com **Ver XML** (visualizar e salvar).

## Banco

`xml_baixados` — CNPJ, NSU, chave, schema, tipo, XML, data e autor.
Índice único por `(cnpj, chave)` evita duplicar a mesma nota.

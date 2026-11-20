# Baixar XML

Baixa os documentos fiscais eletrônicos (DF-e) direto da SEFAZ, usando o
certificado digital do estabelecimento.

- Escolhe o estabelecimento (só aparecem os que têm certificado)
- CNPJ do interessado
- Último NSU e ambiente (produção/homologação)
- Lista os XMLs baixados, com visualização e download

## Como funciona

O navegador não consegue falar com a SEFAZ (exige TLS mútuo com o
certificado). Quem faz a consulta é a Edge Function `baixar-xml`, que:

1. confere o usuário e a permissão no módulo `xml`;
2. pega o certificado no bucket privado e a senha no Vault;
3. monta o SOAP do serviço `NFeDistribuicaoDFe` e assina com o certificado;
4. devolve os XMLs (sem expor a senha).

A função está em `supabase/functions/baixar-xml/index.ts` e o passo a passo
em `docs/BAIXAR-XML.md`.

## Banco

Tabela `xml_baixados` (CNPJ, NSU, chave, schema, XML), com RLS pelo módulo
`xml` do Controle de Acesso.

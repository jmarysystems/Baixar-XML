import { listar, rpc } from '../api.js';
import { sb } from '../api.js';
import * as ui from '../ui.js';

export async function render(raiz, ctx) {
  ctx.setTitulo('Baixar XML');

  const podeBaixar = ctx.pode('xml', 'cadastrar');
  const podeExcluir = ctx.pode('xml', 'excluir');

  const lojas = await listar('arm_lojas', { ordem: 'nome' });
  const comCertificado = lojas.filter((l) => l.certificado_caminho);

  const baixados = await listar('xml_baixados', {
    select: '*, arm_lojas(nome)',
    ordem: 'baixado_em',
    asc: false,
  });

  raiz.innerHTML = `
    <div class="cartao">
      <div class="cartao-topo"><h2>Baixar XML da SEFAZ</h2></div>
      <p class="sub">Escolha o estabelecimento (com certificado digital), confirme o CNPJ
        e baixe os documentos fiscais eletrônicos.</p>
      <div class="sub" style="background:#eef3fb;border:1px solid #cfe0f6;border-radius:8px;padding:12px 14px;margin:12px 0">
        <strong>Como baixar:</strong> a SEFAZ exige o certificado na própria conexão
        (TLS mútuo), e o servidor do site não consegue fechar essa conexão.
        Dê <strong>dois cliques em "Baixar XML.bat"</strong> no computador que tem o
        certificado — ele baixa e grava aqui automaticamente.
      </div>

      <form id="form" class="grade grade-2">
        <label class="campo"><span>Estabelecimento</span>
          <select name="loja_id" id="loja" required>
            <option value="">—</option>
            ${comCertificado.map((l) => `<option value="${ui.esc(l.id)}"
               data-cnpj="${ui.esc(l.cnpj_cpf || '')}">${ui.esc(l.nome)}</option>`).join('')}
          </select></label>

        <label class="campo"><span>CNPJ</span>
          <input name="cnpj" id="cnpj" placeholder="somente números" required></label>

        <label class="campo"><span>Último NSU</span>
          <input name="ult_nsu" id="ult_nsu" placeholder="0" value="0"></label>

        <label class="campo"><span>Ambiente</span>
          <select name="tp_amb">
            <option value="1">1 - Produção</option>
            <option value="2">2 - Homologação</option>
          </select></label>

        ${podeBaixar ? `<div class="linha-acoes campo-largo">
          <button type="submit" class="botao-pequeno" id="baixar">Tentar pelo servidor</button>
          <span class="sub" id="status"></span>
        </div>` : ''}
      </form>
    </div>

    <div class="cartao">
      <div class="cartao-topo"><h2>${baixados.length} documento(s) baixado(s)</h2></div>
      ${baixados.length ? `<div class="tabela-rolagem"><table>
        <thead><tr><th>CNPJ</th><th>Chave</th><th>Tipo</th><th>NSU</th>
          <th>Estabelecimento</th><th>Baixado em</th><th></th></tr></thead>
        <tbody>
          ${baixados.map((d) => `<tr>
            <td class="mono">${ui.esc(d.cnpj)}</td>
            <td class="mono">${ui.esc(d.chave || '—')}</td>
            <td>${ui.esc(d.tipo || d.schema || '—')}</td>
            <td class="mono">${ui.esc(d.nsu || '—')}</td>
            <td>${ui.esc(d.arm_lojas?.nome || '—')}</td>
            <td>${ui.dataHoraBR(d.baixado_em)}</td>
            <td class="acoes">
              <button type="button" class="botao-pequeno" data-ver="${ui.esc(d.id)}">Ver XML</button>
              ${podeExcluir ? `<button type="button" class="botao-pequeno botao-perigo"
                data-excluir="${ui.esc(d.id)}">Excluir</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : ui.vazio('Nenhum XML baixado ainda.')}
    </div>`;

  const selLoja = raiz.querySelector('#loja');
  const campoCnpj = raiz.querySelector('#cnpj');
  const campoNsu = raiz.querySelector('#ult_nsu');
  const status = raiz.querySelector('#status');

  selLoja.addEventListener('change', () => {
    const opcao = selLoja.selectedOptions[0];
    const cnpj = (opcao?.dataset.cnpj || '').replace(/\D/g, '');
    if (cnpj) campoCnpj.value = cnpj;
  });

  raiz.querySelector('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const dados = new FormData(ev.target);
    const lojaId = dados.get('loja_id');
    const cnpj = String(dados.get('cnpj') || '').replace(/\D/g, '');
    const ultNsu = String(dados.get('ult_nsu') || '0').replace(/\D/g, '') || '0';
    const tpAmb = String(dados.get('tp_amb') || '1');

    if (!lojaId) { ui.toast('Escolha o estabelecimento.', 'erro'); return; }
    if (cnpj.length !== 14) { ui.toast('Informe um CNPJ com 14 dígitos.', 'erro'); return; }

    const botao = raiz.querySelector('#baixar');
    botao.disabled = true;
    botao.textContent = 'Consultando a SEFAZ…';
    if (status) status.textContent = '';

    try {
      let data = null;
      const resposta = await sb.functions.invoke('baixar-xml', {
        body: { loja_id: lojaId, cnpj, ult_nsu: ultNsu, tp_amb: tpAmb },
      });

      if (resposta.error) {
        let detalhe = resposta.error.message || 'Erro no serviço.';
        try {
          const corpo = await resposta.error.context.json();
          if (corpo?.erro) detalhe = corpo.erro;
          if (corpo?.detalhe) detalhe += ` (${corpo.detalhe})`;
        } catch (_) { /* sem corpo JSON */ }

        if (/Failed to send a request|not found|non-2xx|FunctionsFetchError/i.test(detalhe)) {
          throw new Error(
            'O download pelo servidor não está disponível. Use o "Baixar XML.bat" '
            + 'no computador que tem o certificado.');
        }
        throw new Error(detalhe);
      }

      data = resposta.data;
      if (data?.erro) throw new Error(data.erro);

      const documentos = data?.documentos || [];
      if (!documentos.length) {
        ui.toast('Nenhum documento novo. Último NSU: ' + (data?.ult_nsu || ultNsu));
        if (status) status.textContent = `Nenhum documento novo · último NSU ${data?.ult_nsu || ultNsu}`;
      } else {
        for (const doc of documentos) {
          await sb.from('xml_baixados').insert({
            loja_id: lojaId,
            cnpj,
            nsu: doc.nsu || null,
            chave: doc.chave || null,
            schema: doc.schema || null,
            tipo: doc.tipo || null,
            xml: doc.xml,
            criado_por: ctx.perfil?.id || null,
          });
        }
        ui.toast(`${documentos.length} documento(s) baixado(s).`);
      }
      ctx.recarregar();
    } catch (erro) {
      ui.toast(erro.message, 'erro');
      if (status) status.textContent = erro.message;
    } finally {
      botao.disabled = false;
      botao.textContent = 'Tentar pelo servidor';
    }
  });

  for (const b of raiz.querySelectorAll('[data-ver]')) {
    b.addEventListener('click', () => {
      const doc = baixados.find((d) => d.id === b.dataset.ver);
      if (!doc) return;
      const { fechar, corpo } = ui.modal({
        titulo: `XML — ${doc.chave || doc.nsu || ''}`,
        largura: '900px',
        corpo: `<pre style="max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap">${
          ui.esc(doc.xml.slice(0, 20000))}</pre>
          <div class="linha-acoes"><button type="button" class="botao-pequeno" id="baixar-arquivo">
            Baixar arquivo</button></div>`,
      });
      corpo.querySelector('#baixar-arquivo').addEventListener('click', () => {
        const blob = new Blob([doc.xml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${doc.chave || doc.nsu || 'documento'}.xml`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
      void fechar;
    });
  }

  for (const b of raiz.querySelectorAll('[data-excluir]')) {
    b.addEventListener('click', async () => {
      if (!window.confirm('Excluir este XML?')) return;
      try {
        await sb.from('xml_baixados').delete().eq('id', b.dataset.excluir);
        ui.toast('XML excluído.');
        ctx.recarregar();
      } catch (erro) { ui.toast(erro.message, 'erro'); }
    });
  }
}

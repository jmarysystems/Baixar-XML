import { listar, criar } from '../api.js';
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
    limite: 200,
  });

  const pedidos = await listar('xml_pedidos', { ordem: 'criado_em', asc: false, limite: 10 });

  raiz.innerHTML = `
    <div class="cartao">
      <div class="cartao-topo"><h2>Baixar XML da SEFAZ</h2></div>
      <p class="sub">Escolha o estabelecimento (com certificado digital), confirme o CNPJ
        e o sistema busca os documentos direto na SEFAZ.</p>

      <form id="form" class="grade grade-2">
        <label class="campo"><span>Estabelecimento</span>
          <select name="loja_id" id="loja" required>
            <option value="">—</option>
            ${comCertificado.map((l) => `<option value="${ui.esc(l.id)}"
               data-cnpj="${ui.esc(l.cnpj_cpf || '')}"
               data-cuf="${ui.esc((l.codigo_ibge_estado || '').padStart(2, '0'))}"
               data-uf="${ui.esc(l.sigla_estado || '')}">${ui.esc(l.nome)}</option>`).join('')}
          </select></label>

        <label class="campo"><span>CNPJ</span>
          <input name="cnpj" id="cnpj" placeholder="somente números" required></label>

        <label class="campo"><span>Último NSU</span>
          <input name="ult_nsu" id="ult_nsu" value="0"></label>

        <label class="campo"><span>Ambiente</span>
          <select name="tp_amb">
            <option value="1">1 - Produção</option>
            <option value="2">2 - Homologação</option>
          </select></label>

        ${podeBaixar ? `<div class="linha-acoes campo-largo">
          <button type="submit" class="botao-primario" id="baixar">Baixar XML</button>
          <span class="sub" id="status"></span>
        </div>` : ''}
      </form>
    </div>

    <div id="andamento"></div>

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
  const andamento = raiz.querySelector('#andamento');

  selLoja.addEventListener('change', () => {
    const opcao = selLoja.selectedOptions[0];
    const cnpj = (opcao?.dataset.cnpj || '').replace(/\D/g, '');
    if (cnpj) campoCnpj.value = cnpj;
  });

  let intervalo = null;

  function acompanhar(pedidoId) {
    if (intervalo) clearInterval(intervalo);

    intervalo = setInterval(async () => {
      const { data } = await sb.from('xml_pedidos').select('*').eq('id', pedidoId).maybeSingle();
      if (!data) return;

      if (data.status === 'concluido') {
        clearInterval(intervalo);
        andamento.innerHTML = `<div class="cartao" style="border-color:#bfe3cd">
          <strong>✅ Concluído</strong> — ${ui.esc(data.mensagem || 'documentos baixados')}
        </div>`;
        status.textContent = '';
        setTimeout(() => ctx.recarregar(), 1200);
      } else if (data.status === 'erro') {
        clearInterval(intervalo);
        andamento.innerHTML = `<div class="cartao" style="border-color:#f3c6c2">
          <strong>⚠️ Não foi possível baixar</strong> — ${ui.esc(data.mensagem || 'erro')}
        </div>`;
        status.textContent = '';
        const botao = raiz.querySelector('#baixar');
        if (botao) { botao.disabled = false; botao.textContent = 'Baixar XML'; }
      } else if (data.status === 'pendente' && data.mensagem) {
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Na fila</strong> — ${ui.esc(data.mensagem)}.
          O sistema tenta de novo automaticamente.
        </div>`;
      } else {
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Processando…</strong> — buscando os documentos na SEFAZ.
        </div>`;
      }
    }, 5000);
  }

  raiz.querySelector('#form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const dados = new FormData(ev.target);
    const lojaId = dados.get('loja_id');
    const cnpj = String(dados.get('cnpj') || '').replace(/\D/g, '');
    const ultNsu = String(dados.get('ult_nsu') || '0').replace(/\D/g, '') || '0';
    const tpAmb = String(dados.get('tp_amb') || '1');
    const opcao = selLoja.selectedOptions[0];

    if (!lojaId) { ui.toast('Escolha o estabelecimento.', 'erro'); return; }
    if (cnpj.length !== 14) { ui.toast('Informe um CNPJ com 14 dígitos.', 'erro'); return; }

    const botao = raiz.querySelector('#baixar');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    try {
      const pedido = await criar('xml_pedidos', {
        loja_id: lojaId,
        cnpj,
        ult_nsu: ultNsu,
        tp_amb: tpAmb,
        cuf: (opcao?.dataset.cuf || '23').slice(0, 2),
        criado_por: ctx.perfil?.id || null,
      });

      andamento.innerHTML = `<div class="cartao">
        <strong>⏳ Processando…</strong> — buscando os documentos na SEFAZ.
        Pode levar alguns minutos.</div>`;
      if (status) status.textContent = 'pedido enviado';
      botao.textContent = 'Aguarde…';

      acompanhar(pedido.id);
    } catch (erro) {
      ui.toast(erro.message, 'erro');
      botao.disabled = false;
      botao.textContent = 'Baixar XML';
    }
  });

  for (const b of raiz.querySelectorAll('[data-ver]')) {
    b.addEventListener('click', () => {
      const doc = baixados.find((d) => d.id === b.dataset.ver);
      if (!doc) return;
      const { corpo } = ui.modal({
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

  // pedido ainda em andamento ao abrir a tela
  const ativo = pedidos.find((p) => p.status === 'pendente' || p.status === 'processando');
  if (ativo) {
    andamento.innerHTML = `<div class="cartao"><strong>⏳ Processando…</strong>
      — pedido de ${ui.dataHoraBR(ativo.criado_em)}.</div>`;
    acompanhar(ativo.id);
  }
}

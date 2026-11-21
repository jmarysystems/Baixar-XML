import { listar, criar } from '../api.js?v=20261121g';
import { sb } from '../api.js?v=20261121g';
import * as ui from '../ui.js?v=20261121g';

// Prazo da manifestação do destinatário: 15 dias a partir da emissão
const DIAS_PRAZO = 15;

function prazoManifestacao(d) {
  if (!(d.tipo || '').startsWith('resNFe') || !d.emitida_em) return null;

  const emissao = new Date(d.emitida_em);
  if (Number.isNaN(emissao.getTime())) return null;

  const prazo = new Date(emissao.getTime() + DIAS_PRAZO * 24 * 60 * 60 * 1000);
  const hoje = new Date();
  const dias = Math.floor((prazo - hoje) / (24 * 60 * 60 * 1000));

  if (dias < 0) {
    return {
      classe: 'badge-vermelho',
      texto: `não manifestada · vencido há ${Math.abs(dias)}d`,
      vencida: true,
    };
  }
  if (dias === 0) {
    return { classe: 'badge-laranja', texto: 'vence hoje', vencida: false };
  }
  if (dias <= 5) {
    return { classe: 'badge-amarelo', texto: `faltam ${dias} dia(s)`, vencida: false };
  }
  return { classe: 'badge-verde', texto: `faltam ${dias} dias`, vencida: false };
}

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

  let config = { automatico: false, loja_id: null, cnpj: null, ult_nsu: '0' };
  try {
    const { data } = await sb.from('xml_config').select('*').eq('id', true).maybeSingle();
    if (data) config = data;
  } catch (_) { /* mantém o padrão desligado */ }

  const opcoesLoja = comCertificado.map((l) => `<option value="${ui.esc(l.id)}"
      data-cnpj="${ui.esc(l.cnpj_cpf || '')}"
      data-cuf="${ui.esc((l.codigo_ibge_estado || '').padStart(2, '0'))}">
      ${ui.esc(l.nome)}</option>`).join('');

  raiz.innerHTML = `
    <div class="cartao">
      <div class="cartao-topo"><h2>Baixar XML da SEFAZ</h2></div>
      <p class="sub">Escolha o estabelecimento (com certificado digital) e como quer buscar:
        pela sequência de documentos (NSU) ou por uma nota específica (chave de acesso).</p>

      <div class="abas" id="abas">
        <button type="button" class="aba ativa" data-aba="nsu">Por NSU</button>
        <button type="button" class="aba" data-aba="chave">Por Chave da NF-e</button>
      </div>

      <form id="form-nsu" data-painel="nsu" class="grade grade-2">
        <label class="campo"><span>Estabelecimento</span>
          <select name="loja_id" class="loja" required>
            <option value="">—</option>${opcoesLoja}
          </select></label>
        <label class="campo"><span>CNPJ</span>
          <input name="cnpj" class="cnpj" placeholder="somente números" required></label>
        <label class="campo"><span>Último NSU</span>
          <input name="ult_nsu" value="0"></label>
        <label class="campo"><span>Ambiente</span>
          <select name="tp_amb">
            <option value="1">1 - Produção</option>
            <option value="2">2 - Homologação</option>
          </select></label>
        ${podeBaixar ? `<div class="linha-acoes campo-largo">
          <button type="submit" class="botao-primario">Baixar por NSU</button>
        </div>` : ''}
      </form>

      <form id="form-chave" data-painel="chave" class="grade grade-2" hidden>
        <label class="campo"><span>Estabelecimento</span>
          <select name="loja_id" class="loja" required>
            <option value="">—</option>${opcoesLoja}
          </select></label>
        <label class="campo"><span>CNPJ</span>
          <input name="cnpj" class="cnpj" placeholder="somente números" required></label>
        <label class="campo campo-largo"><span>Chave da NF-e (44 dígitos)</span>
          <input name="chave" maxlength="44" placeholder="ex.: 23260853622664000159550010000002171300002300" required></label>
        <label class="campo"><span>Ambiente</span>
          <select name="tp_amb">
            <option value="1">1 - Produção</option>
            <option value="2">2 - Homologação</option>
          </select></label>
        ${podeBaixar ? `<div class="linha-acoes campo-largo">
          <button type="submit" class="botao-primario">Baixar pela chave</button>
        </div>` : ''}
      </form>

      <div id="status-linha" class="sub" style="margin-top:8px"></div>
    </div>

    <div class="cartao">
      <div class="cartao-topo"><h2>Download automático por NSU</h2></div>
      <p class="sub">Ligado, o sistema busca os documentos novos sozinho, respeitando
        o intervalo que a SEFAZ permite. Desligado por padrão.</p>

      <label class="campo" style="flex-direction:row;align-items:center;gap:10px">
        <input type="checkbox" id="auto" ${config.automatico ? 'checked' : ''}
               style="width:18px;height:18px">
        <span style="font-weight:600">Baixar automaticamente</span>
      </label>

      <div class="grade grade-2" style="margin-top:12px">
        <label class="campo"><span>Estabelecimento</span>
          <select id="auto-loja">
            <option value="">—</option>
            ${comCertificado.map((l) => `<option value="${ui.esc(l.id)}"
               data-cnpj="${ui.esc(l.cnpj_cpf || '')}"
               data-cuf="${ui.esc((l.codigo_ibge_estado || '').padStart(2, '0'))}"
               ${config.loja_id === l.id ? 'selected' : ''}>${ui.esc(l.nome)}</option>`).join('')}
          </select></label>
        <label class="campo"><span>CNPJ</span>
          <input id="auto-cnpj" value="${ui.esc(config.cnpj || '')}" placeholder="somente números"></label>
      </div>

      <div class="linha-acoes" style="margin-top:12px">
        <button type="button" class="botao-pequeno" id="salvar-auto">Salvar configuração</button>
        <span class="sub" id="auto-status"></span>
      </div>
    </div>

    <div id="andamento"></div>

    <div class="cartao">
      <div class="cartao-topo"><h2><span id="contador">${baixados.length}</span> documento(s) baixado(s)</h2></div>
      <div class="grade grade-2" style="max-width:720px">
        <label class="campo"><span>Pesquisar</span>
          <input type="search" id="busca-docs"
                 placeholder="NSU, chave, CNPJ do emitente ou destinatário, nome ou tipo"></label>
        <label class="campo"><span>Filtrar</span>
          <select id="filtro-prazo">
            <option value="todos">Todos os documentos</option>
            <option value="vencidas">Não manifestadas — prazo vencido</option>
            <option value="no_prazo">Não manifestadas — dentro do prazo</option>
          </select></label>
      </div>

      <div class="linha-acoes" style="margin-top:12px;flex-wrap:wrap">
        <button type="button" class="botao-pequeno" id="lote-manifestar">
          Manifestar todas as vencidas (<span id="qtd-vencidas">0</span>)
        </button>
        <button type="button" class="botao-pequeno botao-perigo" id="lote-negar">
          Negar todas as vencidas (<span id="qtd-vencidas-2">0</span>)
        </button>
        <span class="sub" id="lote-status"></span>
      </div>
      ${baixados.length ? `<div class="tabela-rolagem"><table>
        <thead><tr><th>CNPJ</th><th>Emitente</th><th>Chave</th><th>Tipo</th><th>Emissão</th>
          <th>Prazo de manifestação</th><th>Manifestação</th><th>Recebimento</th><th>NSU</th>
          <th>Estabelecimento</th><th>Baixado em</th><th></th></tr></thead>
        <tbody>
          ${baixados.map((d) => `<tr data-id="${ui.esc(d.id)}" data-busca="${ui.esc(
            `${d.nsu || ''} ${d.chave || ''} ${d.cnpj || ''} ${d.tipo || ''} ` +
            `${d.emitente_cnpj || ''} ${d.emitente_nome || ''} ${d.schema || ''}`
              .toLowerCase())}">
            <td class="mono">${ui.esc(d.cnpj)}</td>
            <td class="mono">${ui.esc(d.emitente_cnpj || '—')}${
              d.emitente_nome
                ? `<br><small class="sub" style="font-size:11px">${ui.esc(d.emitente_nome)}</small>`
                : ''}</td>
            <td class="mono">${ui.esc(d.chave || '—')}</td>
            <td>${ui.esc(d.tipo || d.schema || '—')}</td>
            <td>${d.emitida_em ? ui.dataBR(d.emitida_em) : '—'}</td>
            <td>${(() => {
              const p = prazoManifestacao(d);
              return p ? `<span class="badge ${p.classe}">${ui.esc(p.texto)}</span>` : '—';
            })()}</td>
            <td>${(() => {
              const resumo = (d.tipo || '').startsWith('resNFe') && d.chave;
              if (!resumo) {
                return d.tipo === 'NF-e'
                  ? '<span class="badge badge-ok">completa</span>' : '—';
              }
              if (d.manifestacao === 'ciencia') {
                return '<span class="badge badge-verde">manifestada</span>';
              }
              if (d.manifestacao === 'nao_realizada') {
                return '<span class="badge badge-vermelho">não recebida</span>';
              }
              return `<button type="button" class="botao-pequeno"
                        data-manifestar="${ui.esc(d.chave)}"
                        data-loja="${ui.esc(d.loja_id || '')}">Manifestar</button>`;
            })()}</td>
            <td>${(() => {
              const resumo = (d.tipo || '').startsWith('resNFe') && d.chave;
              if (!resumo) return '—';
              if (d.manifestacao) {
                return d.manifestacao === 'nao_realizada'
                  ? '<span class="badge badge-vermelho">negado</span>'
                  : '<span class="badge badge-verde">aceito</span>';
              }
              const prazo = prazoManifestacao(d);
              if (!prazo || prazo.vencida) {
                return '<span class="sub" title="fora do prazo para negar">—</span>';
              }
              return `<button type="button" class="botao-pequeno botao-perigo"
                        data-negar="${ui.esc(d.chave)}"
                        data-loja="${ui.esc(d.loja_id || '')}"
                        data-emitente="${ui.esc(d.emitente_nome || '')}">Negar</button>`;
            })()}</td>
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

  // ---------------------------------------------------------------- abas
  const abas = raiz.querySelectorAll('#abas .aba');
  for (const aba of abas) {
    aba.addEventListener('click', () => {
      for (const a of abas) a.classList.toggle('ativa', a === aba);
      for (const painel of raiz.querySelectorAll('[data-painel]')) {
        painel.hidden = painel.dataset.painel !== aba.dataset.aba;
      }
    });
  }

  // ------------------------------------------------- CNPJ automático
  for (const form of raiz.querySelectorAll('form[data-painel]')) {
    const selLoja = form.querySelector('.loja');
    const campoCnpj = form.querySelector('.cnpj');
    selLoja.addEventListener('change', () => {
      const cnpj = (selLoja.selectedOptions[0]?.dataset.cnpj || '').replace(/\D/g, '');
      if (cnpj) campoCnpj.value = cnpj;
    });
  }

  const andamento = raiz.querySelector('#andamento');
  const statusLinha = raiz.querySelector('#status-linha');
  let intervalo = null;

  function acompanhar(pedidoId) {
    if (intervalo) clearInterval(intervalo);
    intervalo = setInterval(async () => {
      const { data } = await sb.from('xml_pedidos').select('*').eq('id', pedidoId).maybeSingle();
      if (!data) return;

      if (data.status === 'concluido') {
        clearInterval(intervalo);
        andamento.innerHTML = `<div class="cartao" style="border-color:#bfe3cd">
          <strong>✅ Concluído</strong> — ${ui.esc(data.mensagem || '')}</div>`;
        statusLinha.textContent = '';
        setTimeout(() => ctx.recarregar(), 1200);
      } else if (data.status === 'erro') {
        clearInterval(intervalo);
        andamento.innerHTML = `<div class="cartao" style="border-color:#f3c6c2">
          <strong>⚠️ Não foi possível baixar</strong> — ${ui.esc(data.mensagem || 'erro')}</div>`;
        statusLinha.textContent = '';
        liberarBotoes();
      } else if (data.status === 'pendente' && data.mensagem) {
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Na fila</strong> — ${ui.esc(data.mensagem)}.
          O sistema tenta de novo automaticamente.</div>`;
      } else {
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Processando…</strong> — buscando os documentos na SEFAZ.</div>`;
      }
    }, 5000);
  }

  function liberarBotoes() {
    for (const b of raiz.querySelectorAll('button[type="submit"]')) {
      b.disabled = false;
      b.textContent = b.dataset.rotulo;
    }
  }

  for (const b of raiz.querySelectorAll('button[type="submit"]')) {
    b.dataset.rotulo = b.textContent;
  }

  // ------------------------------------------------------------ envio
  async function enviar(ev, porChave) {
    ev.preventDefault();
    const form = ev.target;
    const dados = new FormData(form);
    const lojaId = dados.get('loja_id');
    const cnpj = String(dados.get('cnpj') || '').replace(/\D/g, '');
    const tpAmb = String(dados.get('tp_amb') || '1');
    const cuf = (form.querySelector('.loja').selectedOptions[0]?.dataset.cuf || '23').slice(0, 2);
    const chave = porChave ? String(dados.get('chave') || '').replace(/\D/g, '') : null;

    if (!lojaId) { ui.toast('Escolha o estabelecimento.', 'erro'); return; }
    if (cnpj.length !== 14) { ui.toast('Informe um CNPJ com 14 dígitos.', 'erro'); return; }
    if (porChave && chave.length !== 44) {
      ui.toast('A chave da NF-e tem 44 dígitos.', 'erro');
      return;
    }

    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = 'Enviando…';

    try {
      const pedido = await criar('xml_pedidos', {
        loja_id: lojaId,
        cnpj,
        chave,
        ult_nsu: porChave ? '0' : (String(dados.get('ult_nsu') || '0').replace(/\D/g, '') || '0'),
        tp_amb: tpAmb,
        cuf,
        criado_por: ctx.perfil?.id || null,
      });

      andamento.innerHTML = `<div class="cartao">
        <strong>⏳ Processando…</strong> — buscando na SEFAZ. Pode levar alguns minutos.</div>`;
      statusLinha.textContent = porChave ? 'pedido pela chave enviado' : 'pedido por NSU enviado';
      botao.textContent = 'Aguarde…';
      acompanhar(pedido.id);
    } catch (erro) {
      ui.toast(erro.message, 'erro');
      botao.disabled = false;
      botao.textContent = botao.dataset.rotulo;
    }
  }

  raiz.querySelector('#form-nsu').addEventListener('submit', (ev) => enviar(ev, false));
  raiz.querySelector('#form-chave').addEventListener('submit', (ev) => enviar(ev, true));

  // ------------------------------------------------------- visualizar
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

  // ------------------------------------------------------ ações em lote
  function vencidasNaoManifestadas() {
    return baixados.filter((d) => {
      if (!(d.tipo || '').startsWith('resNFe') || !d.chave) return false;
      if (d.manifestacao) return false;
      const p = prazoManifestacao(d);
      return !!p && p.vencida;
    });
  }

  function atualizarContadores() {
    const total = vencidasNaoManifestadas().length;
    const a = raiz.querySelector('#qtd-vencidas');
    const b = raiz.querySelector('#qtd-vencidas-2');
    if (a) a.textContent = total;
    if (b) b.textContent = total;
    const botaoM = raiz.querySelector('#lote-manifestar');
    const botaoN = raiz.querySelector('#lote-negar');
    if (botaoM) botaoM.disabled = total === 0;
    if (botaoN) botaoN.disabled = total === 0;
  }
  atualizarContadores();

  async function enviarLote(acao, justificativa) {
    const docs = vencidasNaoManifestadas();
    if (!docs.length) { ui.toast('Nenhuma nota vencida pendente.', 'erro'); return; }

    const rotulo = acao === 'negar' ? 'negar' : 'manifestar';
    if (!window.confirm(
      `Confirmar ${rotulo} ${docs.length} nota(s) com prazo vencido?\n\n` +
      'Cada uma gera um evento na SEFAZ. As que forem recusadas ficam marcadas com o motivo.')) {
      return;
    }

    const statusLote = raiz.querySelector('#lote-status');
    const botoes = [raiz.querySelector('#lote-manifestar'), raiz.querySelector('#lote-negar')];
    botoes.forEach((b) => { if (b) b.disabled = true; });

    let enviados = 0;
    for (const d of docs) {
      try {
        await criar('xml_pedidos', {
          acao,
          loja_id: d.loja_id,
          cnpj: d.cnpj,
          chave: d.chave,
          justificativa,
          ult_nsu: '0',
          tp_amb: '1',
          cuf: '23',
          criado_por: ctx.perfil?.id || null,
        });
        enviados += 1;
        if (statusLote) statusLote.textContent = `enfileirando ${enviados}/${docs.length}…`;
      } catch (erro) {
        ui.toast(erro.message, 'erro');
        break;
      }
    }

    if (statusLote) {
      statusLote.textContent = `${enviados} nota(s) na fila — o sistema envia em lotes de 25 por rodada`;
    }
    ui.toast(`${enviados} nota(s) enviadas para a fila.`);
    setTimeout(() => ctx.recarregar(), 4000);
  }

  raiz.querySelector('#lote-manifestar')?.addEventListener('click', () => enviarLote('manifestar', null));
  raiz.querySelector('#lote-negar')?.addEventListener('click', () => {
    const motivo = window.prompt(
      'Motivo da negativa (mínimo 15 caracteres), aplicado a todas as notas vencidas:',
      'Mercadoria nao recebida / operacao nao realizada');
    if (motivo === null) return;
    if (motivo.trim().length < 15) {
      ui.toast('A justificativa precisa de pelo menos 15 caracteres.', 'erro');
      return;
    }
    enviarLote('negar', motivo.trim());
  });

  // --------------------------------------------------- negar recebimento
  for (const b of raiz.querySelectorAll('[data-negar]')) {
    b.addEventListener('click', async () => {
      const chave = b.dataset.negar;
      const lojaId = b.dataset.loja;
      const emitente = b.dataset.emitente || '';
      if (!lojaId) { ui.toast('Documento sem estabelecimento vinculado.', 'erro'); return; }

      const justificativa = window.prompt(
        `Negar o recebimento da nota${emitente ? ` de ${emitente}` : ''}?\n\n` +
        `Chave: ${chave}\n\n` +
        'Descreva o motivo (mínimo 15 caracteres). Isso registra a "Operação não Realizada" na SEFAZ:',
        'Mercadoria nao recebida / operacao nao realizada');
      if (justificativa === null) return;
      if (justificativa.trim().length < 15) {
        ui.toast('A justificativa precisa de pelo menos 15 caracteres.', 'erro');
        return;
      }

      b.disabled = true;
      b.textContent = 'Enviando…';
      try {
        const pedido = await criar('xml_pedidos', {
          acao: 'negar',
          loja_id: lojaId,
          cnpj: b.closest('tr').querySelector('td').textContent.trim(),
          chave,
          justificativa: justificativa.trim(),
          ult_nsu: '0',
          tp_amb: '1',
          cuf: '23',
          criado_por: ctx.perfil?.id || null,
        });
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Negativa enviada para a fila</strong> — a SEFAZ registra o evento
          e a linha passa a mostrar "não recebida".</div>`;
        acompanhar(pedido.id);
      } catch (erro) {
        ui.toast(erro.message, 'erro');
        b.disabled = false;
        b.textContent = 'Negar';
      }
    });
  }

  // ------------------------------------------------ manifestar
  for (const b of raiz.querySelectorAll('[data-manifestar]')) {
    b.addEventListener('click', async () => {
      const chave = b.dataset.manifestar;
      const lojaId = b.dataset.loja;
      if (!lojaId) { ui.toast('Documento sem estabelecimento vinculado.', 'erro'); return; }

      const confirmar = window.confirm(
        `Manifestar "Ciência da Emissão" para a nota\n${chave}?\n\n` +
        'Isso registra o evento na SEFAZ e libera o XML completo.');
      if (!confirmar) return;

      b.disabled = true;
      b.textContent = 'Enviando…';
      try {
        const pedido = await criar('xml_pedidos', {
          acao: 'manifestar',
          loja_id: lojaId,
          cnpj: b.closest('tr').querySelector('td').textContent.trim(),
          chave,
          ult_nsu: '0',
          tp_amb: '1',
          cuf: '23',
          criado_por: ctx.perfil?.id || null,
        });
        andamento.innerHTML = `<div class="cartao">
          <strong>⏳ Manifestação enviada para a fila</strong> — a SEFAZ processa
          em instantes e o XML completo aparece na lista.</div>`;
        acompanhar(pedido.id);
      } catch (erro) {
        ui.toast(erro.message, 'erro');
        b.disabled = false;
        b.textContent = 'Manifestar';
      }
    });
  }

  // --------------------------------------------- pesquisa nos baixados
  const buscaDocs = raiz.querySelector('#busca-docs');
  const filtroPrazo = raiz.querySelector('#filtro-prazo');
  const contador = raiz.querySelector('#contador');

  const categorias = new Map();
  for (const d of baixados) {
    const p = prazoManifestacao(d);
    categorias.set(d.id, p ? (p.vencida ? 'vencidas' : 'no_prazo') : 'outros');
  }

  function aplicarFiltros() {
    const termo = (buscaDocs?.value || '').trim().toLowerCase();
    const modo = filtroPrazo?.value || 'todos';
    let visiveis = 0;

    for (const tr of raiz.querySelectorAll('tr[data-busca]')) {
      const id = tr.dataset.id;
      const categoria = categorias.get(id) || 'outros';
      const casaTexto = !termo || tr.dataset.busca.includes(termo);
      const casaPrazo = modo === 'todos' || categoria === modo;
      const mostra = casaTexto && casaPrazo;

      tr.hidden = !mostra;
      if (mostra) visiveis += 1;
    }

    if (contador) {
      const filtrando = !!termo || modo !== 'todos';
      contador.textContent = filtrando ? `${visiveis} de ${baixados.length}` : baixados.length;
    }
  }

  buscaDocs?.addEventListener('input', aplicarFiltros);
  filtroPrazo?.addEventListener('change', aplicarFiltros);

  // ------------------------------------------------- download automático
  const caixaAuto = raiz.querySelector('#auto');
  const autoLoja = raiz.querySelector('#auto-loja');
  const autoCnpj = raiz.querySelector('#auto-cnpj');
  const autoStatus = raiz.querySelector('#auto-status');
  let ultimoNsu = config.ult_nsu || '0';

  function mostrarStatus() {
    if (!autoStatus) return;
    autoStatus.textContent = caixaAuto.checked
      ? `ligado · último NSU ${ultimoNsu}`
      : 'desligado';
  }
  mostrarStatus();

  autoLoja.addEventListener('change', () => {
    const cnpj = (autoLoja.selectedOptions[0]?.dataset.cnpj || '').replace(/\D/g, '');
    if (cnpj) autoCnpj.value = cnpj;
  });

  raiz.querySelector('#salvar-auto').addEventListener('click', async () => {
    const cnpj = autoCnpj.value.replace(/\D/g, '');
    const lojaId = autoLoja.value || null;

    if (caixaAuto.checked && (!lojaId || cnpj.length !== 14)) {
      ui.toast('Escolha o estabelecimento e informe o CNPJ.', 'erro');
      return;
    }

    const botao = raiz.querySelector('#salvar-auto');
    botao.disabled = true;
    try {
      const cuf = (autoLoja.selectedOptions[0]?.dataset.cuf || '23').slice(0, 2);
      const { error } = await sb.from('xml_config').update({
        automatico: caixaAuto.checked,
        loja_id: lojaId,
        cnpj: cnpj || null,
        cuf,
        atualizado_em: new Date().toISOString(),
        atualizado_por: ctx.perfil?.id || null,
      }).eq('id', true);
      if (error) throw error;

      mostrarStatus();
      ui.toast(caixaAuto.checked
        ? 'Download automático ligado.'
        : 'Download automático desligado.');
    } catch (erro) {
      ui.toast(erro.message, 'erro');
    } finally {
      botao.disabled = false;
    }
  });

  const ativo = pedidos.find((p) => p.status === 'pendente' || p.status === 'processando');
  if (ativo) {
    andamento.innerHTML = `<div class="cartao"><strong>⏳ Em andamento</strong>
      — pedido de ${ui.dataHoraBR(ativo.criado_em)}${ativo.chave ? ' (por chave)' : ' (por NSU)'}.</div>`;
    acompanhar(ativo.id);
  }
}

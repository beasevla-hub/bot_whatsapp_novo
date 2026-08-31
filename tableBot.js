const fs = require('fs');
const { spawn } = require('child_process');
const { sincronizarNotion, precisaSincronizar } = require('./sync');
const dotenv = require('dotenv');

dotenv.config();

const DATABASE_PATH = './database.json';
const ORGAOS_DB_PATH = './database_orgaos.json';

const estadosConversa = new Map();
let sincronizacaoEmAndamento = null;

async function garantirDatabaseAtualizada() {
  if (!precisaSincronizar()) return;
  if (!sincronizacaoEmAndamento) {
    sincronizacaoEmAndamento = sincronizarNotion()
      .catch(error => {
        console.error('⚠️ Não foi possível atualizar o cache do Notion; usando a cópia local:', error.message);
      })
      .finally(() => { sincronizacaoEmAndamento = null; });
  }
  await sincronizacaoEmAndamento;
}

const ORGAOS_HARDCODED = [
  {
    nome_oficial: 'SEME',
    aliases: [
      'seme',
      'secretaria municipal de esportes e lazer',
      'secretaria de esportes e lazer',
      'municipal de esportes e lazer',
      'esportes e lazer'
    ]
  },
  {
    nome_oficial: 'SIURB',
    aliases: [
      'siurb',
      'secretaria municipal de infraestrutura urbana',
      'secretaria de infraestrutura urbana',
      'infraestrutura urbana'
    ]
  },
  {
    nome_oficial: 'SMSUB',
    aliases: [
      'smsub',
      'smsub cogel',
      'smsub - cogel',
      'secretaria municipal das subprefeituras',
      'secretaria das subprefeituras',
      'municipal das subprefeituras'
    ]
  },
  {
    nome_oficial: 'São Paulo Obras',
    aliases: [
      'spobras',
      'sp obras',
      'sao paulo obras',
      'são paulo obras'
    ]
  }
];

function removerAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizarTexto(texto) {
  return removerAcentos(texto)
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function limparStopwords(texto) {
  const stopwords = ['da', 'de', 'do', 'das', 'dos', 'o', 'a', 'os', 'as', 'subprefeitura', 'sub', 'pmsp', 'prefeitura', 'municipal', 'próximas', 'proximas', 'próxima', 'proxima', 'me', 'manda', 'vê', 'ver', 'por', 'favor', 'obrigado', 'valeu', 'gentileza'];
  return normalizarTexto(texto)
    .split(' ')
    .filter(palavra => palavra && !stopwords.includes(palavra))
    .join(' ')
    .trim();
}

function carregarDatabase() {
  if (!fs.existsSync(DATABASE_PATH)) {
    throw new Error('database.json não encontrado. Execute sincronização primeiro.');
  }
  return JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf-8'));
}

function carregarDatabaseOrgaos() {
  try {
    const hardcoded = ORGAOS_HARDCODED.map(item => ({
      ...item,
      aliasesNormalizados: Array.from(new Set(item.aliases.map(normalizarTexto).filter(Boolean)))
    }));

    if (!fs.existsSync(ORGAOS_DB_PATH)) return hardcoded;
    const content = JSON.parse(fs.readFileSync(ORGAOS_DB_PATH, 'utf-8'));
    const subprefs = Array.isArray(content.subprefeituras_sp) ? content.subprefeituras_sp : [];
    const prefeituras = Array.isArray(content.prefeituras_sp) ? content.prefeituras_sp : [];
    const prefeiturasExemplos = Array.isArray(content.prefeituras_exemplos) ? content.prefeituras_exemplos : [];
    const base = [...subprefs, ...prefeituras, ...prefeiturasExemplos].map(item => ({
      ...item,
      aliasesNormalizados: Array.from(new Set((item.aliases || []).map(normalizarTexto).filter(Boolean)))
    }));
    return [...hardcoded, ...base];
  } catch (error) {
    console.error('❌ Erro ao carregar database_orgaos.json:', error);
    return ORGAOS_HARDCODED.map(item => ({
      ...item,
      aliasesNormalizados: Array.from(new Set(item.aliases.map(normalizarTexto).filter(Boolean)))
    }));
  }
}

function extrairTexto(props, fieldName) {
  const field = props?.[fieldName] || {};
  if (field.title?.[0]?.plain_text) return field.title[0].plain_text;
  if (field.rich_text?.[0]?.plain_text) return field.rich_text[0].plain_text;
  return '';
}

function obterOrgaoDaLicitacao(props) {
  return extrairTexto(props, 'ÓRGÃO/CLIENTE')
    || extrairTexto(props, 'CLIENTE')
    || extrairTexto(props, 'ÓRGÃO')
    || extrairTexto(props, 'ORGAO')
    || extrairTexto(props, 'SUBPREFEITURA')
    || '';
}

function extrairOrgaoConcatenado(props) {
  const partes = [
    extrairTexto(props, 'ÓRGÃO/CLIENTE'),
    extrairTexto(props, 'CLIENTE'),
    extrairTexto(props, 'ÓRGÃO'),
    extrairTexto(props, 'ORGAO'),
    extrairTexto(props, 'SUBPREFEITURA')
  ].map(v => String(v || '').trim()).filter(Boolean);

  return [...new Set(partes)].join(' - ');
}

function encontrarOrgaoHardcoded(texto) {
  const textoNorm = normalizarTexto(texto);
  if (!textoNorm) return null;
  for (const item of ORGAOS_HARDCODED) {
    const aliases = item.aliases.map(normalizarTexto);
    if (aliases.includes(textoNorm) || aliases.some(alias => textoNorm.includes(alias) || alias.includes(textoNorm))) {
      return item.nome_oficial;
    }
  }
  return null;
}

function encontrarOrgaoPadronizado(texto, baseOrgaos) {
  const textoNorm = normalizarTexto(texto);
  if (!textoNorm) return null;

  const hardcoded = encontrarOrgaoHardcoded(textoNorm);
  if (hardcoded) return hardcoded;

  for (const item of baseOrgaos) {
    if (item.aliasesNormalizados.includes(textoNorm)) return item.nome_oficial;
  }

  for (const item of baseOrgaos) {
    if (item.aliasesNormalizados.some(alias => textoNorm.includes(alias) || alias.includes(textoNorm))) {
      return item.nome_oficial;
    }
  }

  return null;
}

function padronizarNomeOrgao(orgaoBruto, baseOrgaos) {
  if (!orgaoBruto) return 'Órgão não informado';
  let texto = String(orgaoBruto).trim();
  texto = texto.replace(/^[^A-Za-zÀ-ÿ0-9]+\s*/g, '');
  texto = texto.replace(/^[A-Za-z]{1,4}\)\s*/g, '');
  const hardcoded = encontrarOrgaoHardcoded(texto);
  if (hardcoded) return hardcoded;
  const padronizado = encontrarOrgaoPadronizado(texto, baseOrgaos);
  return padronizado || texto;
}

function mapearOrgaosConhecidos(baseOrgaos) {
  try {
    const database = carregarDatabase();
    const orgaos = new Set(ORGAOS_HARDCODED.map(item => item.nome_oficial));

    (database.data || []).forEach(licitacao => {
      const props = licitacao.properties || {};
      const orgaoOriginal = extrairOrgaoConcatenado(props) || obterOrgaoDaLicitacao(props);
      if (orgaoOriginal) orgaos.add(orgaoOriginal.trim());
      const orgaoPadronizado = padronizarNomeOrgao(orgaoOriginal, baseOrgaos);
      if (orgaoPadronizado) orgaos.add(orgaoPadronizado.trim());
    });

    return Array.from(orgaos);
  } catch (error) {
    console.error('❌ Erro ao mapear órgãos conhecidos:', error);
    return ORGAOS_HARDCODED.map(item => item.nome_oficial);
  }
}

function extrairLocalInteligente(texto, orgaosConhecidos, baseOrgaos) {
  const textoOriginal = String(texto || '').trim();
  const hardcoded = encontrarOrgaoHardcoded(textoOriginal);
  if (hardcoded) return hardcoded;

  const padronizadoDireto = encontrarOrgaoPadronizado(textoOriginal, baseOrgaos);
  if (padronizadoDireto) return padronizadoDireto;

  const textoNorm = normalizarTexto(textoOriginal);
  for (const orgao of orgaosConhecidos) {
    const orgaoNorm = normalizarTexto(orgao);
    if (textoNorm.includes(orgaoNorm) || orgaoNorm.includes(textoNorm)) {
      return padronizarNomeOrgao(orgao, baseOrgaos);
    }
  }

  const limpo = limparStopwords(textoOriginal);
  const hardcodedLimpo = encontrarOrgaoHardcoded(limpo);
  if (hardcodedLimpo) return hardcodedLimpo;
  const padronizadoLimpo = encontrarOrgaoPadronizado(limpo, baseOrgaos);
  return padronizadoLimpo || textoOriginal;
}

function parseDataBR(texto) {
  const match = String(texto).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const data = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  if (Number.isNaN(data.getTime())) return null;
  if (data.getDate() !== Number(dd) || data.getMonth() + 1 !== Number(mm) || data.getFullYear() !== Number(yyyy)) return null;
  return data;
}

function formatDateISO(date) {
  return new Date(date).toISOString().split('T')[0];
}

function criarLicitacaoComOrgaoPadronizado(licitacao, baseOrgaos) {
  const clone = JSON.parse(JSON.stringify(licitacao));
  const props = clone.properties || {};
  const orgaoOriginal = extrairOrgaoConcatenado(props) || obterOrgaoDaLicitacao(props);
  const orgaoPadronizado = padronizarNomeOrgao(orgaoOriginal, baseOrgaos);

  if (!props['ÓRGÃO/CLIENTE']) props['ÓRGÃO/CLIENTE'] = { rich_text: [] };
  props['ÓRGÃO/CLIENTE'].rich_text = [{ plain_text: orgaoPadronizado }];

  if (!props['ÓRGÃO/CLIENTE'].title || !Array.isArray(props['ÓRGÃO/CLIENTE'].title) || props['ÓRGÃO/CLIENTE'].title.length === 0) {
    props['ÓRGÃO/CLIENTE'].title = [{ plain_text: orgaoPadronizado }];
  } else {
    props['ÓRGÃO/CLIENTE'].title[0].plain_text = orgaoPadronizado;
  }

  clone.properties = props;
  return clone;
}

async function buscarLicitacoes(localBusca, dataInicio, dataFim) {
  try {
    const database = carregarDatabase();
    const baseOrgaos = carregarDatabaseOrgaos();
    const buscaNormalizada = normalizarTexto(localBusca);
    const inicio = new Date(dataInicio);
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date(dataFim);
    fim.setHours(23, 59, 59, 999);

    const resultados = (database.data || []).filter(licitacao => {
      const props = licitacao.properties || {};
      const orgaoOriginal = extrairOrgaoConcatenado(props) || obterOrgaoDaLicitacao(props);
      const orgaoPadronizado = padronizarNomeOrgao(orgaoOriginal, baseOrgaos);
      const combinado = [orgaoOriginal, orgaoPadronizado].map(normalizarTexto).join(' | ');
      if (!combinado.includes(buscaNormalizada)) return false;

      const dataField = props['DATA E HORA']?.date?.start;
      if (!dataField) return false;
      const dataLicitacao = new Date(dataField);
      return dataLicitacao >= inicio && dataLicitacao <= fim;
    }).map(licitacao => criarLicitacaoComOrgaoPadronizado(licitacao, baseOrgaos));

    resultados.sort((a, b) => {
      const da = new Date(a.properties?.['DATA E HORA']?.date?.start || 0).getTime();
      const db = new Date(b.properties?.['DATA E HORA']?.date?.start || 0).getTime();
      return da - db;
    });

    return resultados;
  } catch (error) {
    console.error('❌ Erro ao buscar licitações no cache:', error);
    return [];
  }
}

async function buscarLicitacoesGerais(dataInicio, dataFim) {
  try {
    const database = carregarDatabase();
    const baseOrgaos = carregarDatabaseOrgaos();
    const inicio = new Date(dataInicio);
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date(dataFim);
    fim.setHours(23, 59, 59, 999);

    const resultados = (database.data || []).filter(licitacao => {
      const props = licitacao.properties || {};
      const dataField = props['DATA E HORA']?.date?.start;
      if (!dataField) return false;
      const dataLicitacao = new Date(dataField);
      return dataLicitacao >= inicio && dataLicitacao <= fim;
    }).map(licitacao => criarLicitacaoComOrgaoPadronizado(licitacao, baseOrgaos));

    resultados.sort((a, b) => {
      const da = new Date(a.properties?.['DATA E HORA']?.date?.start || 0).getTime();
      const db = new Date(b.properties?.['DATA E HORA']?.date?.start || 0).getTime();
      return da - db;
    });

    return resultados;
  } catch (error) {
    console.error('❌ Erro ao buscar licitações gerais no cache:', error);
    return [];
  }
}

async function gerarPDF(licitacoes, localBusca, dataInicio, dataFim, ocultarAptos = false, modo = 'detalhado') {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const jsonPath = `./licitacoes_${timestamp}.json`;
    const pdfPath = `./relatorio_${timestamp}.pdf`;

    try {
      const payload = {
        local_busca: localBusca,
        data_inicio: formatDateISO(dataInicio),
        data_fim: formatDateISO(dataFim),
        gerado_em: new Date().toISOString(),
        ocultar_aptos: ocultarAptos,
        modo,
        licitacoes
      };

      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
      const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
      const pythonProcess = spawn(pythonCommand, ['gerador_pdf.py', jsonPath, localBusca, pdfPath]);

      pythonProcess.stderr.on('data', data => console.error('Erro no Python:', data.toString()));
      pythonProcess.stdout.on('data', data => console.log('Saída do Python:', data.toString()));

      pythonProcess.on('close', code => {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        if (code === 0 && fs.existsSync(pdfPath)) return resolve(pdfPath);
        reject(new Error(`Script Python falhou com código ${code}`));
      });

      pythonProcess.on('error', error => {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        reject(new Error(`Erro ao executar script Python: ${error.message}`));
      });
    } catch (error) {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      reject(error);
    }
  });
}

// ============================================================
// COMUNICAÇÃO WHATSAPP (recebe socket compartilhado)
// ============================================================

async function sendText(sock, chatId, text) {
  try {
    await sock.sendMessage(chatId, { text });
  } catch (error) {
    console.error('❌ Erro ao enviar texto:', error);
  }
}

async function sendPdf(sock, chatId, pdfPath, localBusca, sufixo = '') {
  const fileNameForUser = `relatorio_${normalizarTexto(localBusca).replace(/\s+/g, '_')}${sufixo}.pdf`;
  try {
    await sock.sendMessage(chatId, {
      document: fs.readFileSync(pdfPath),
      fileName: fileNameForUser,
      mimetype: 'application/pdf'
    });
    console.log(`✅ Relatório em PDF enviado com sucesso!`);
  } catch (error) {
    console.error('❌ Erro ao enviar PDF:', error);
  } finally {
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  }
}

// ============================================================
// TIMER VIP (60 SEGUNDOS)
// ============================================================

function iniciarTimer(stateKey, sock, chatId) {
  const estado = estadosConversa.get(stateKey);
  if (estado && estado.timer) clearTimeout(estado.timer);

  const timer = setTimeout(async () => {
    estadosConversa.delete(stateKey);
    await sendText(sock, chatId, '⏳ Janela de atendimento encerrada por inatividade (1 minuto). Chame novamente com "tabela [local]" quando precisar.');
    console.log(`⏱️ Atendimento encerrado por inatividade para: ${stateKey.replace('@s.whatsapp.net', '')}`);
  }, 60000);

  if (estado) {
    estado.timer = timer;
    estadosConversa.set(stateKey, estado);
  }
}

// ============================================================
// FLUXOS DE BUSCA
// ============================================================

async function processarBuscaDetalhada(sock, chatId, stateKey, localBusca, dataInicio, dataFim) {
  console.log(`🔎 Iniciando busca detalhada para: ${localBusca}`);
  await sendText(sock, chatId, `Buscando licitações de ${localBusca} entre ${dataInicio.toLocaleDateString('pt-BR')} e ${dataFim.toLocaleDateString('pt-BR')}...`);

  const licitacoes = await buscarLicitacoes(localBusca, dataInicio, dataFim);

  if (licitacoes.length === 0) {
    console.log(`⚠️ Nenhuma licitação encontrada para: ${localBusca}`);
    await sendText(sock, chatId, `Não encontrei nenhuma licitação para "${localBusca}" entre ${dataInicio.toLocaleDateString('pt-BR')} e ${dataFim.toLocaleDateString('pt-BR')}.`);
    return;
  }

  try {
    const pdfPath = await gerarPDF(licitacoes, localBusca, dataInicio, dataFim, false, 'detalhado');
    await sendPdf(sock, chatId, pdfPath, localBusca, '');

    estadosConversa.set(stateKey, {
      etapa: 'aguardando_ocultar_aptos',
      tipoRelatorio: 'detalhado',
      localBusca,
      dataInicio: formatDateISO(dataInicio),
      dataFim: formatDateISO(dataFim),
      licitacoes
    });

    iniciarTimer(stateKey, sock, chatId);
    await sendText(sock, chatId, 'Ocultar aptos? Responda: sim ou não.');
  } catch (error) {
    console.error('❌ Erro ao gerar/enviar PDF detalhado:', error);
    await sendText(sock, chatId, 'Ocorreu um erro ao gerar o relatório. Tente novamente.');
  }
}

async function processarBuscaGeral(sock, chatId, stateKey, dataInicio, dataFim) {
  console.log(`📊 Iniciando montagem de tabela geral`);
  await sendText(sock, chatId, `Montando tabela geral entre ${dataInicio.toLocaleDateString('pt-BR')} e ${dataFim.toLocaleDateString('pt-BR')}...`);

  const licitacoes = await buscarLicitacoesGerais(dataInicio, dataFim);

  if (licitacoes.length === 0) {
    console.log(`⚠️ Nenhuma licitação encontrada para a tabela geral.`);
    await sendText(sock, chatId, `Não encontrei licitações para a tabela geral entre ${dataInicio.toLocaleDateString('pt-BR')} e ${dataFim.toLocaleDateString('pt-BR')}.`);
    return;
  }

  try {
    const pdfPath = await gerarPDF(licitacoes, 'geral', dataInicio, dataFim, true, 'geral');
    await sendPdf(sock, chatId, pdfPath, 'geral', '');
    estadosConversa.delete(stateKey);
  } catch (error) {
    console.error('❌ Erro ao gerar/enviar PDF geral:', error);
    await sendText(sock, chatId, 'Ocorreu um erro ao gerar a tabela geral. Tente novamente.');
  }
}

// ============================================================
// ENTRY POINT DO TABLEBOT (chamado pelo router)
// ============================================================

async function processMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const participant = isGroup ? msg.key.participant : chatId;
  const stateKey = participant;

  const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  if (!messageText) return;

  const textoOriginal = messageText.trim();
  const textoLimpo = textoOriginal.replace(/@\d+/g, '').trim();
  const textoLower = textoLimpo.toLowerCase();

  console.log(`\n📩 [TableBot] Mensagem de ${participant.replace('@s.whatsapp.net', '')} em ${isGroup ? 'Grupo' : 'Privado'}: "${textoOriginal}"`);

  // Atualiza o cache apenas quando necessário; falhas mantêm o último cache válido.
  await garantirDatabaseAtualizada();

  // MOTOR DE DETECÇÃO
  let ehNovoPedido = false;
  let isGeral = false;
  let localBusca = '';

  if (textoLower === 'tabela geral') {
    ehNovoPedido = true;
    isGeral = true;
  } else {
    const match = textoLimpo.match(/^tabela\s+(.+)/i);
    if (match) {
      ehNovoPedido = true;
      localBusca = match[1].trim();
    }
  }

  if (ehNovoPedido) {
    const estadoAntigo = estadosConversa.get(stateKey);
    if (estadoAntigo && estadoAntigo.timer) clearTimeout(estadoAntigo.timer);

    if (isGeral) {
      estadosConversa.set(stateKey, {
        etapa: 'aguardando_opcao_data',
        tipoRelatorio: 'geral',
        localBusca: 'geral'
      });
      await sendText(sock, chatId, 'Identifiquei seu pedido para: tabela geral.\n\nDigite 1 para data atual até as próximas.\nDigite 2 para data personalizada.');
    } else {
      const baseOrgaos = carregarDatabaseOrgaos();
      const orgaosConhecidos = mapearOrgaosConhecidos(baseOrgaos);
      const localBuscaInteligente = extrairLocalInteligente(localBusca, orgaosConhecidos, baseOrgaos);

      estadosConversa.set(stateKey, {
        etapa: 'aguardando_opcao_data',
        tipoRelatorio: 'detalhado',
        localBusca: localBuscaInteligente
      });
      await sendText(sock, chatId, `Identifiquei seu pedido para: ${localBuscaInteligente}.\n\nDigite 1 para data atual até as próximas.\nDigite 2 para data personalizada.`);
    }

    iniciarTimer(stateKey, sock, chatId);
    return;
  }

  // ------------------------------------------------------------------
  // SE NÃO FOR UM PEDIDO NOVO, VERIFICA SE A PESSOA JÁ ESTÁ NA "SALA VIP"
  // ------------------------------------------------------------------
  const estado = estadosConversa.get(stateKey);
  if (!estado) return;

  if (estado.timer) clearTimeout(estado.timer);

  if (estado.etapa === 'aguardando_ocultar_aptos') {
    if (textoLower === 'sim') {
      try {
        console.log(`⚙️ Gerando versão sem aptos...`);
        const pdfPath = await gerarPDF(
          estado.licitacoes,
          estado.localBusca,
          new Date(`${estado.dataInicio}T00:00:00`),
          new Date(`${estado.dataFim}T23:59:59`),
          true,
          'detalhado'
        );
        await sendPdf(sock, chatId, pdfPath, estado.localBusca, '_sem_aptos');
        await sendText(sock, chatId, 'Pronto. Enviei a versão sem a coluna APTOS.');
      } catch (error) {
        console.error('❌ Erro ao gerar PDF:', error);
        await sendText(sock, chatId, 'Não consegui gerar a versão sem a coluna APTOS.');
      }
      estadosConversa.delete(stateKey);
      return;
    }

    if (textoLower === 'não' || textoLower === 'nao') {
      await sendText(sock, chatId, 'Certo, mantive a versão original com a coluna APTOS.');
      estadosConversa.delete(stateKey);
      return;
    }

    await sendText(sock, chatId, 'Responda apenas com: sim ou não.');
    iniciarTimer(stateKey, sock, chatId);
    return;
  }

  if (estado.etapa === 'aguardando_opcao_data') {
    if (textoLimpo === '1') {
      const hoje = new Date();
      const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 0, 0, 0, 0);
      const fim = new Date(hoje.getFullYear(), 11, 31, 23, 59, 59, 999);

      if (estado.tipoRelatorio === 'geral') {
        await processarBuscaGeral(sock, chatId, stateKey, inicio, fim);
      } else {
        await processarBuscaDetalhada(sock, chatId, stateKey, estado.localBusca, inicio, fim);
      }
      return;
    }

    if (textoLimpo === '2') {
      estadosConversa.set(stateKey, {
        etapa: 'aguardando_data_inicio',
        tipoRelatorio: estado.tipoRelatorio,
        localBusca: estado.localBusca
      });
      await sendText(sock, chatId, 'Insira a data de início no formato DD/MM/AAAA. Exemplo: 01/03/2026');
      iniciarTimer(stateKey, sock, chatId);
      return;
    }

    await sendText(sock, chatId, 'Opção inválida. Digite 1 para data atual até as próximas, ou 2 para data personalizada.');
    iniciarTimer(stateKey, sock, chatId);
    return;
  }

  if (estado.etapa === 'aguardando_data_inicio') {
    const dataInicio = parseDataBR(textoLimpo);
    if (!dataInicio) {
      await sendText(sock, chatId, 'Data inválida. Use o formato DD/MM/AAAA. Exemplo: 01/03/2026');
      iniciarTimer(stateKey, sock, chatId);
      return;
    }

    const fim = new Date(dataInicio.getFullYear(), 11, 31, 23, 59, 59, 999);

    if (estado.tipoRelatorio === 'geral') {
      await processarBuscaGeral(sock, chatId, stateKey, dataInicio, fim);
    } else {
      await processarBuscaDetalhada(sock, chatId, stateKey, estado.localBusca, dataInicio, fim);
    }
    return;
  }
}

module.exports = { processMessage };

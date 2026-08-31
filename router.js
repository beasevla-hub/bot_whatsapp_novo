const fs = require('fs');
const path = require('path');

const OBRAS_PATH = './obras.json';
const ALLOWED_TABLE_GROUP = '120363166889982535@g.us'; // Grupo oficial permitido para o bot de tabelas

function loadObras() {
  if (!fs.existsSync(OBRAS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OBRAS_PATH, 'utf-8'));
  } catch (e) {
    console.error('❌ Erro ao carregar obras.json:', e.message);
    return {};
  }
}

let obrasCache = loadObras();
let obrasCacheTime = Date.now();

function getObras() {
  // Recarrega a cada 30 segundos para permitir hot-reload sem reiniciar o serviço
  if (Date.now() - obrasCacheTime > 30000) {
    obrasCache = loadObras();
    obrasCacheTime = Date.now();
  }
  return obrasCache;
}

/**
 * Roteador principal de mensagens.
 * Recebe o socket Baileys compartilhado e a mensagem.
 * Decide se envia para mediaWatcher, tableBot ou ignora.
 */
async function route(sock, msg) {
  if (!msg.message || msg.key?.fromMe) return;

  const chatId = msg.key?.remoteJid;
  if (!chatId) return;
  if (chatId.endsWith('@broadcast') || chatId.includes('newsletter')) return;

  const isGroup = chatId.endsWith('@g.us');
  const obras = getObras();
  const obraConfig = obras[chatId];

  // ── 1. GRUPO CADASTRADO EM obras.json → mediaWatcher ──
  if (isGroup && obraConfig && obraConfig.ativo !== false) {
    const mediaWatcher = require('./mediaWatcher');
    await mediaWatcher.processMessage(sock, msg, obraConfig);
    return;
  }

  // ── 2. CONVERSA PRIVADA OU GRUPO PERMITIDO PARA TABELAS → tableBot ──
  // O tableBot decide internamente se a mensagem é relevante
  // (novo pedido "tabela ..." ou resposta dentro de um fluxo ativo)
  const isTableAllowed = !isGroup || chatId === ALLOWED_TABLE_GROUP;

  if (isTableAllowed) {
    const tableBot = require('./tableBot');
    await tableBot.processMessage(sock, msg);
    return;
  }

  // ── 3. QUALQUER OUTRA MENSAGEM → ignorar silenciosamente ──
}

module.exports = { route, getObras };

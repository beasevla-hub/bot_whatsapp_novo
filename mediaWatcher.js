const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { getTodayString, getDateString, getNowTimeString, formatTimestamp, isToday, isDate, ensureDir, getFoldersForDay, createDayStructure } = require('./utils');
const { writeJsonAtomic, readJson } = require('./runtime');
const { emitEvent } = require('./monitorClient');

// Tentativa de importar makeInMemoryStore de múltiplas fontes
let makeInMemoryStore = null;
try {
  const baileys = require('@whiskeysockets/baileys');
  if (typeof baileys.makeInMemoryStore === 'function') {
    makeInMemoryStore = baileys.makeInMemoryStore;
  } else if (typeof baileys.default?.makeInMemoryStore === 'function') {
    makeInMemoryStore = baileys.default.makeInMemoryStore;
  }
} catch (e) {}

if (!makeInMemoryStore) {
  try {
    makeInMemoryStore = require('@whiskeysockets/baileys/lib/Store/make-in-memory-store');
    if (makeInMemoryStore.default && typeof makeInMemoryStore.default === 'function') {
      makeInMemoryStore = makeInMemoryStore.default;
    }
  } catch (e) {}
}

// Se makeInMemoryStore não estiver disponível, criar uma store mínima funcional
if (!makeInMemoryStore) {
  console.log('⚠️  makeInMemoryStore não disponível na versão do Baileys. Usando store mínima customizada.');

  makeInMemoryStore = function SimpleStore(config) {
    const chats = new Map();
    const messages = {};

    const store = {
      chats: {
        all: () => Array.from(chats.values()),
        get: (id) => chats.get(id),
        set: (id, val) => chats.set(id, val),
        upsert: (chat) => {
          const existing = chats.get(chat.id);
          if (existing) Object.assign(existing, chat);
          else chats.set(chat.id, chat);
        }
      },
      messages: messages,
      state: { connection: 'close' },

      loadMessages: (jid, count) => {
        const arr = messages[jid] || [];
        return arr.slice(-count);
      },

      bind: (ev) => {
        ev.on('chats.upsert', (newChats) => {
          for (const chat of newChats) store.chats.upsert(chat);
        });
        ev.on('chats.update', (updates) => {
          for (const up of updates) {
            const c = chats.get(up.id);
            if (c) Object.assign(c, up);
          }
        });
        ev.on('messages.upsert', ({ messages: msgs }) => {
          for (const msg of msgs) {
            const jid = msg.key?.remoteJid;
            if (!jid) continue;
            if (!messages[jid]) messages[jid] = [];
            messages[jid].push(msg);
          }
        });
        ev.on('messaging-history.set', ({ messages: msgs }) => {
          for (const msg of msgs) {
            const jid = msg.key?.remoteJid;
            if (!jid) continue;
            if (!messages[jid]) messages[jid] = [];
            messages[jid].push(msg);
          }
        });
      },

      readFromFile: (filePath) => {
        try {
          if (!fs.existsSync(filePath)) return;
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.chats) {
            for (const c of data.chats) chats.set(c.id, c);
          }
          if (data.messages) {
            for (const [jid, msgs] of Object.entries(data.messages)) {
              messages[jid] = msgs;
            }
          }
        } catch (e) {
          console.log('📚 Store do disco corrompida. Iniciando nova.');
        }
      },

      writeToFile: (filePath) => {
        try {
          const data = {
            chats: Array.from(chats.values()),
            messages: messages
          };
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (e) {}
      }
    };

    return store;
  };
}

const pino = require('pino');

// ============================================================
// CONFIGURAÇÃO GLOBAL (compartilhada entre obras)
// ============================================================
const STORE_FILE = './baileys_store.json';
const STATE_FILE = './shared_state.json';
const TIMEZONE = 'America/Sao_Paulo';
const APPEND_IDLE_DELAY = 3000;

// ============================================================
// ESTADO POR OBRA (contextos isolados)
// ============================================================
const obraContexts = new Map();
let store = null;
let isSyncing = false;
let syncCompleted = false;
let appendIdleTimer = null;
let recoveryProcess = null;

// ============================================================
// TIPOS DE MENSAGEM CONHECIDOS
// ============================================================
const TEXT_TYPES = ['conversation', 'extendedTextMessage', 'editedMessage'];
const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage', 'ptt'];
const IGNORE_TYPES = ['senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage', 'reactionMessage', 'pollUpdateMessage'];

/**
 * ⭐ Encontra o tipo REAL da mensagem (ignora chaves auxiliares do WhatsApp).
 */
function getRealMessageType(msg) {
  if (!msg.message) return null;
  const keys = Object.keys(msg.message);

  for (const type of MEDIA_TYPES) {
    if (keys.includes(type)) return type;
  }
  for (const type of TEXT_TYPES) {
    if (keys.includes(type)) return type;
  }
  for (const type of IGNORE_TYPES) {
    if (keys.includes(type)) return type;
  }
  return keys[0] || null;
}

/**
 * ⭐ Extrai a data da mensagem no formato "DD.MM.YYYY" baseado no timestamp.
 */
function getMessageDateStr(msg) {
  const ts = msg.messageTimestamp || msg.messageStubTimestamp;
  if (!ts) return getTodayString();
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
}

// ============================================================
// CONTEXTOS DE OBRA (AGORA POR JID + DATA)
// ============================================================
function getContextKey(remoteJid, dateStr) {
  return `${remoteJid}#${dateStr}`;
}

function getOrCreateObraContext(remoteJid, caminho, targetDateStr = null) {
  const dateStr = targetDateStr || getTodayString();
  const contextKey = getContextKey(remoteJid, dateStr);

  // Se já existe contexto para esse JID + DATA, retorna
  if (obraContexts.has(contextKey)) {
    return obraContexts.get(contextKey);
  }

  // Cria novo contexto para essa data específica
  const ctx = {
    remoteJid,
    dateStr,
    caminho,
    cacheFile: path.join(caminho, '.media_index.json'),
    mediaCache: {},
    transcriptEntries: [],
    counters: { imagem: 0, video: 0, documento: 0, audio: 0 },
    folders: {},
    initialized: false
  };

  // ⭐ Cria estrutura baseada na DATA DA MENSAGEM, não no dia de hoje
  ctx.folders = createDayStructure(caminho, dateStr);
  loadCache(ctx);
  scanExistingFiles(ctx);
  syncCacheWithExistingFiles(ctx);
  ctx.initialized = true;

  obraContexts.set(contextKey, ctx);
  console.log(`📁 Contexto criado para obra ${remoteJid} | Data: ${dateStr}`);
  console.log(`   📂 Caminho base: ${caminho}`);
  console.log(`   📁 Pasta do dia: ${path.basename(ctx.folders.base)}`);
  console.log(`   🔢 Contadores iniciais: Img=${ctx.counters.imagem}, Vid=${ctx.counters.video}, Doc=${ctx.counters.documento}, Aud=${ctx.counters.audio}`);
  return ctx;
}

// ============================================================
// CACHE (por obra - usa o cacheFile global da obra, não por dia)
// ============================================================
function loadCache(ctx) {
  try {
    if (fs.existsSync(ctx.cacheFile)) {
      ctx.mediaCache = JSON.parse(fs.readFileSync(ctx.cacheFile, 'utf-8'));
      console.log(`📦 Cache carregado [${ctx.remoteJid}]: ${Object.keys(ctx.mediaCache).length} entradas.`);
    } else {
      ctx.mediaCache = {};
      console.log(`📦 Cache vazio [${ctx.remoteJid}]. Iniciando novo.`);
    }
  } catch (err) {
    console.error(`❌ Erro ao carregar cache [${ctx.remoteJid}]:`, err.message);
    ctx.mediaCache = {};
  }
}

function saveCache(ctx) {
  try {
    ensureDir(path.dirname(ctx.cacheFile));
    writeJsonAtomic(ctx.cacheFile, ctx.mediaCache);
  } catch (err) {
    console.error(`❌ Erro ao salvar cache [${ctx.remoteJid}]:`, err.message);
  }
}

function getUniqueId(msg) {
  return msg.key?.id || crypto.randomUUID();
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isMediaSaved(uniqueId, ctx) {
  return !!ctx.mediaCache[uniqueId];
}

function registerInCache(uniqueId, fileName, hash, groupName, groupId, type, participant, ctx) {
  ctx.mediaCache[uniqueId] = {
    groupId: groupId || '',
    participant: participant || 'unknown',
    timestamp: Date.now(),
    type: type || 'unknown',
    hash: hash,
    file: fileName,
    downloaded: true
  };
  saveCache(ctx);
}

// ============================================================
// CONTADORES E RECUPERAÇÃO (por obra + dia)
// ============================================================
function scanExistingFiles(ctx) {
  const dirs = [
    { path: ctx.folders.fotosVideos, prefix: 'Imagem_' },
    { path: ctx.folders.fotosVideos, prefix: 'Vídeo_' },
    { path: ctx.folders.documentos, prefix: 'Documento_' },
    { path: ctx.folders.audios, prefix: 'Áudio_' }
  ];

  let maxImagem = 0, maxVideo = 0, maxDocumento = 0, maxAudio = 0;

  for (const { path: dirPath, prefix } of dirs) {
    if (!fs.existsSync(dirPath)) {
      console.log(`   📂 [scan] ${dirPath} não existe. Pulando.`);
      continue;
    }
    const files = fs.readdirSync(dirPath);
    console.log(`   📂 [scan] ${path.basename(dirPath)}: ${files.length} arquivo(s) encontrado(s).`);

    for (const file of files) {
      // ⭐ REGEX SIMPLES E FUNCIONAL
      const match = file.match(new RegExp(`^${prefix}([0-9]+)\.`));
      if (match) {
        const num = parseInt(match[1], 10);
        console.log(`      📄 ${file} → número ${num}`);
        if (prefix === 'Imagem_' && num > maxImagem) maxImagem = num;
        if (prefix === 'Vídeo_' && num > maxVideo) maxVideo = num;
        if (prefix === 'Documento_' && num > maxDocumento) maxDocumento = num;
        if (prefix === 'Áudio_' && num > maxAudio) maxAudio = num;
      }
    }
  }

  ctx.counters.imagem = maxImagem;
  ctx.counters.video = maxVideo;
  ctx.counters.documento = maxDocumento;
  ctx.counters.audio = maxAudio;
}

function syncCacheWithExistingFiles(ctx) {
  const allDirs = [ctx.folders.fotosVideos, ctx.folders.documentos, ctx.folders.audios];
  let synced = 0;

  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const hash = hashBuffer(fs.readFileSync(filePath));
      const alreadyCached = Object.values(ctx.mediaCache).some(entry => entry.hash === hash);
      if (!alreadyCached) {
        const uniqueId = `recovered_${hash.slice(0, 16)}`;
        ctx.mediaCache[uniqueId] = {
          groupId: 'unknown',
          participant: 'unknown',
          timestamp: stat.mtime.getTime(),
          type: 'recovered',
          hash: hash,
          file: file,
          downloaded: true
        };
        synced++;
      }
    }
  }

  if (synced > 0) {
    saveCache(ctx);
    console.log(`🔄 [${ctx.remoteJid} | ${ctx.dateStr}] ${synced} arquivo(s) existente(s) sincronizado(s) no cache.`);
  }
}

// ============================================================
// STORE DO BAILEYS (global, compartilhada)
// ============================================================
function setupStore() {
  store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
  if (fs.existsSync(STORE_FILE)) {
    try {
      store.readFromFile(STORE_FILE);
      console.log('📚 Store carregada do disco.');
    } catch (e) {
      console.log('📚 Store do disco corrompida. Iniciando nova.');
    }
  }
  return store;
}

function persistStore() {
  if (store) {
    try {
      store.writeToFile(STORE_FILE);
    } catch (e) {}
  }
}

// ============================================================
// SINCRONIZADOR (itera sobre obras cadastradas)
// ============================================================
async function runSync(sock) {
  if (isSyncing) return;
  isSyncing = true;

  console.log('');
  console.log('🔄 === SINCRONIZADOR INICIADO ===');
  console.log('   Percorrendo grupos cadastrados em obras.json...');

  const router = require('./router');
  const obras = router.getObras();
  const obrasAtivas = Object.entries(obras).filter(([_, obra]) => obra.ativo !== false);

  console.log(`   Obras ativas encontradas: ${obrasAtivas.length}`);

  let totalMsgs = 0;
  let totalMedia = 0;
  let totalSkipped = 0;
  let totalDownloaded = 0;

  for (const [jid, obra] of obrasAtivas) {
    const ctx = getOrCreateObraContext(jid, obra.caminho);

    let groupName = obra.nome || 'Desconhecido';
    try {
      const meta = await sock.groupMetadata(jid);
      groupName = meta.subject || obra.nome || 'Sem nome';
    } catch (e) {
      // usa nome da obra como fallback
    }

    const msgs = await store.loadMessages(jid, 1000);
    if (!msgs || !msgs.length) continue;

    const todayMsgs = msgs.filter(m => isToday(m.messageTimestamp));
    if (!todayMsgs.length) continue;

    console.log('');
    console.log(`   📂 ${groupName} (${jid})`);
    console.log(`      Mensagens hoje: ${todayMsgs.length}`);

    for (const msg of todayMsgs) {
      totalMsgs++;
      const result = await processSingleMessage(msg, sock, groupName, ctx, true);
      if (result === 'media') totalMedia++;
      if (result === 'skip') totalSkipped++;
      if (result === 'download') totalDownloaded++;
    }
  }

  console.log('');
  console.log('📊 === RESUMO DA SINCRONIZAÇÃO ===');
  console.log(`   Mensagens analisadas: ${totalMsgs}`);
  console.log(`   Mídias encontradas:   ${totalMedia}`);
  console.log(`   Já existiam (skip):   ${totalSkipped}`);
  console.log(`   Baixadas agora:       ${totalDownloaded}`);
  console.log('   ==================================');
  console.log('');

  isSyncing = false;
}

// ============================================================
// LOGS
// ============================================================
function logFound(type) {
  console.log('');
  console.log(`📥 ${type} encontrado.`);
}

function logSkip() {
  console.log('   ✅ Já existe (cache).');
  console.log('   🚫 Ignorada.');
  console.log('   --------------------');
}

function logDownload(fileName, filePath) {
  console.log('   ❌ Não existe no cache.');
  console.log('   ⬇️  Baixando...');
  console.log(`   💾 Salva: ${fileName}`);
  console.log(`   📂 Caminho: ${filePath}`);
  console.log('   --------------------');
}

// ============================================================
// MÍDIA
// ============================================================
function getExtensionFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/3gpp': 'mp3',
    'audio/ogg': 'mp3',
    'audio/opus': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/zip': 'zip',
    'application/vnd.rar': 'rar',
    'application/x-rar-compressed': 'rar',
    'application/vnd.android.package-archive': 'apk'
  };
  return map[mime] || 'bin';
}

function classifyMedia(messageType, msg) {
  if (messageType === 'imageMessage' || messageType === 'stickerMessage') {
    return { type: 'image', folder: 'fotosVideos', prefix: 'Imagem_' };
  }
  if (messageType === 'videoMessage') {
    return { type: 'video', folder: 'fotosVideos', prefix: 'Vídeo_' };
  }
  if (messageType === 'documentMessage') {
    return { type: 'document', folder: 'documentos', prefix: 'Documento_' };
  }
  if (messageType === 'audioMessage' || messageType === 'ptt') {
    return { type: 'audio', folder: 'audios', prefix: 'Áudio_' };
  }
  return null;
}

function generateFileName(mediaInfo, msg, ctx) {
  const mime = msg.message[Object.keys(msg.message).find(k => MEDIA_TYPES.includes(k))]?.mimetype || 'application/octet-stream';
  const ext = getExtensionFromMime(mime);

  if (mediaInfo.type === 'image') {
    ctx.counters.imagem++;
    return `Imagem_${String(ctx.counters.imagem).padStart(3, '0')}.${ext}`;
  }
  if (mediaInfo.type === 'video') {
    ctx.counters.video++;
    return `Vídeo_${String(ctx.counters.video).padStart(3, '0')}.${ext}`;
  }
  if (mediaInfo.type === 'document') {
    ctx.counters.documento++;
    const doc = msg.message.documentMessage;
    const originalExt = doc.fileName ? path.extname(doc.fileName).slice(1) : ext;
    return `Documento_${String(ctx.counters.documento).padStart(3, '0')}.${originalExt || ext}`;
  }
  if (mediaInfo.type === 'audio') {
    ctx.counters.audio++;
    return `Áudio_${String(ctx.counters.audio).padStart(3, '0')}.${ext}`;
  }
  return null;
}

async function downloadMedia(msg, sock) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
    );
    return buffer;
  } catch (err) {
    console.error('   ❌ Falha no download:', err.message);
    emitEvent({ module: 'baileys', severity: 'error', eventType: 'media_download_error', message: 'Falha ao baixar mídia', details: { error: err.message } });
    return null;
  }
}

async function handleMedia(msg, sock, groupName, groupId, silent, ctx) {
  const messageType = getRealMessageType(msg);
  const mediaInfo = classifyMedia(messageType, msg);
  if (!mediaInfo) return null;

  const uniqueId = getUniqueId(msg);

  if (!silent) logFound(mediaInfo.type.charAt(0).toUpperCase() + mediaInfo.type.slice(1));

  if (isMediaSaved(uniqueId, ctx)) {
    if (!silent) logSkip();
    return 'skip';
  }

  const buffer = await downloadMedia(msg, sock);
  if (!buffer) return null;

  const hash = hashBuffer(buffer);
  const hashExists = Object.values(ctx.mediaCache).some(entry => entry.hash === hash);
  if (hashExists) {
    if (!silent) {
      console.log('   ✅ Já existe (hash idêntico).');
      console.log('   🚫 Ignorada.');
      console.log('   --------------------');
    }
    return 'skip';
  }

  const fileName = generateFileName(mediaInfo, msg, ctx);
  const filePath = path.join(ctx.folders[mediaInfo.folder], fileName);

  fs.writeFileSync(filePath, buffer);
  registerInCache(uniqueId, fileName, hash, groupName, groupId, mediaInfo.type, msgParticipant(msg), ctx);
  if (!silent) logDownload(fileName, filePath);
  emitEvent({ module: 'baileys', severity: 'info', eventType: 'media_saved', message: 'Mídia salva com sucesso', groupLabel: groupName, senderLabel: msgParticipant(msg), mediaLabel: fileName, details: { mediaType: mediaInfo.type } });
  return 'download';
}

// ============================================================
// TRANSCRIPT (por obra)
// ============================================================
function msgParticipant(msg) {
  if (!msg) return 'Desconhecido';
  return (msg.key?.participant || msg.key?.remoteJid || 'Desconhecido')
    .replace('@s.whatsapp.net', '')
    .replace('@g.us', '')
    .replace('@lid', '');
}

function addTranscriptEntry(msg, groupName, ctx) {
  const text = msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.editedMessage?.message?.conversation || '';

  if (!text || !text.trim()) return;

  const time = formatTimestamp(msg.messageTimestamp) || getNowTimeString();
  const participant = msgParticipant(msg);

  ctx.transcriptEntries.push({ time, participant, text: text.trim(), group: groupName });
}

function generateTranscript(ctx) {
  if (ctx.transcriptEntries.length === 0) return;

  const lines = [];
  for (const entry of ctx.transcriptEntries) {
    lines.push(entry.time);
    lines.push(entry.participant);
    lines.push(entry.text);
    lines.push('--------------------------------');
    lines.push('');
  }

  const content = lines.join('\n');
  const filePath = path.join(ctx.folders.transcript, 'conversa.txt');

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('');
  console.log(`📝 Transcript gerado [${ctx.remoteJid} | ${ctx.dateStr}]: ${ctx.transcriptEntries.length} mensagens salvas em ${filePath}`);
  ctx.transcriptEntries = [];
}

function scheduleTranscript() {
  setInterval(() => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour12: false });
    if (timeStr === '23:59:00' || timeStr === '23:59:01') {
      for (const ctx of obraContexts.values()) {
        generateTranscript(ctx);
      }
    }
  }, 1000);
}

// ============================================================
// PROCESSAMENTO DE MENSAGEM ÚNICA
// ============================================================
async function processSingleMessage(msg, sock, groupName, ctx, silent = false) {
  if (!msg.message || msg.key?.fromMe) return null;

  const chatId = msg.key?.remoteJid;
  if (!chatId || !chatId.endsWith('@g.us')) return null;
  if (chatId.endsWith('@broadcast') || chatId.includes('newsletter')) return null;

  const messageType = getRealMessageType(msg);

  if (!silent && messageType && !TEXT_TYPES.includes(messageType) && !MEDIA_TYPES.includes(messageType) && !IGNORE_TYPES.includes(messageType)) {
    console.log(`   ⚠️  Tipo de mensagem desconhecido: ${messageType}`);
  }

  if (TEXT_TYPES.includes(messageType)) {
    addTranscriptEntry(msg, groupName, ctx);
    return 'text';
  }

  if (MEDIA_TYPES.includes(messageType)) {
    const result = await handleMedia(msg, sock, groupName, chatId, silent, ctx);
    return result || 'media';
  }

  return null;
}

// ============================================================
// ENTRY POINT DO MEDIAWATCHER (chamado pelo router)
// ============================================================
async function processMessage(sock, msg, obraConfig) {
  if (!msg.message || msg.key?.fromMe) return;

  const chatId = msg.key?.remoteJid;
  const isGroup = chatId && chatId.endsWith('@g.us');
  if (!isGroup) return;
  if (chatId.endsWith('@broadcast') || chatId.includes('newsletter')) return;

  // ⭐ EXTRAI A DATA DA MENSAGEM (não usa hoje cegamente)
  const msgDateStr = getMessageDateStr(msg);

  const ctx = getOrCreateObraContext(chatId, obraConfig.caminho, msgDateStr);
  const participant = msg.key?.participant || chatId;

  let groupName = obraConfig.nome || 'Desconhecido';
  try {
    const metadata = await sock.groupMetadata(chatId);
    groupName = metadata.subject || obraConfig.nome || 'Sem nome';
  } catch (e) {
    // silence
  }

  console.log('');
  console.log('====================================');
  console.log(`Grupo: ${groupName}`);
  console.log(`ID: ${chatId}`);
  console.log(`Data msg: ${msgDateStr}`);
  console.log(`Pasta: ${path.basename(ctx.folders.base)}`);
  console.log(`Participante: ${participant.replace('@s.whatsapp.net', '').replace('@lid', '')}`);
  console.log('====================================');

  await processSingleMessage(msg, sock, groupName, ctx, false);
}

// ============================================================
// SHARED STATE & RECOVERY (global)
// ============================================================
function updateSharedState(updates) {
  try {
    const state = { ...readJson(STATE_FILE, {}), ...updates };
    writeJsonAtomic(STATE_FILE, state);
  } catch (e) {
    console.error('❌ Erro ao atualizar shared_state:', e.message);
  }
}

function checkIfRecoveryNeeded() {
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const lastDisconnect = state.last_baileys_disconnect;
    if (!lastDisconnect) return false;
    const diff = Date.now() - new Date(lastDisconnect).getTime();
    return diff > 60 * 60 * 1000;  // ⭐ 1 hora
  } catch (e) {
    return false;
  }
}

function startRecovery() {
  if (recoveryProcess) {
    console.log('   ⚠️  Recovery já está rodando. Aguardando...');
    return;
  }

  console.log('');
  console.log('🚨 ================================================');
  console.log('🚨 BAILEYS DETECTOU PERÍODO OFFLINE SIGNIFICATIVO');
  console.log('🚨 Iniciando módulo de recuperação (whatsapp-web.js)');
  console.log('🚨 ================================================');

  recoveryProcess = spawn('node', ['recovery.js'], {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  recoveryProcess.on('close', (code) => {
    console.log('');
    console.log(`✅ Recovery finalizado com código ${code}`);
    recoveryProcess = null;

    // Limpa todos os contextos para forçar recriação com dados atualizados
    obraContexts.clear();
    console.log('🧹 Contextos limpos. Serão recriados na próxima mensagem.');

    // ⭐ Limpa o last_disconnect para não disparar recovery de novo
    updateSharedState({ last_baileys_disconnect: null, recovery_status: 'completed' });
  });

  recoveryProcess.on('error', (err) => {
    console.error('');
    console.error('❌ Erro ao iniciar recovery:', err.message);
    recoveryProcess = null;
  });
}

// ============================================================
// INIT (chamado pelo index.js na inicialização)
// ============================================================
function init() {
  scheduleTranscript();
  console.log('📚 MediaWatcher inicializado. Store e transcript agendados.');
}

module.exports = {
  setupStore,
  persistStore,
  init,
  processMessage,
  runSync,
  updateSharedState,
  checkIfRecoveryNeeded,
  startRecovery
};

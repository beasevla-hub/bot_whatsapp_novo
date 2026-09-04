const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { getTodayString, getDateString, ensureDir, getFoldersForDay, createDayStructure, isDate } = require('./utils');
const { writeJsonAtomic, acquireProcessLock } = require('./runtime');
const { emitEvent } = require('./monitorClient');

// ============================================================
// PARSE DE ARGUMENTOS DE LINHA DE COMANDO
// ============================================================
const args = process.argv.slice(2);
const argMap = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.split('=');
    argMap[key] = value !== undefined ? value : true;
  }
}

const TARGET_DATE = argMap['--date'] || null;          // ex: "04.08.2026"
const FORCE_DOWNLOAD = argMap['--force'] === true || argMap['--clear-cache'] === true;

// ============================================================
// CONFIGURAÇÃO
// ============================================================
const OBRAS_PATH = './obras.json';
const STATE_FILE = './shared_state.json';
const TIMEZONE = 'America/Sao_Paulo';
const PHONE_NUMBER = '5511947380028';
const RECOVERY_TIMEOUT_MS = 900000; // 15 minutos
const PRE_FETCH_DELAY_MS = 30000;   // 30 segundos esperando WhatsApp Web carregar histórico
const FETCH_BATCH_DELAY_MS = 8000;  // 8 segundos entre tentativas de fetch
const MAX_FETCH_ATTEMPTS = 10;      // Máximo de 10 tentativas

// ============================================================
// ESTADO
// ============================================================
let recoveryTimedOut = false;
let wasDisconnected = false;

// ============================================================
// UTILITÁRIOS LOCAIS
// ============================================================
function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour12: false });
}

function formatDateBR(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('pt-BR', { timeZone: TIMEZONE });
}

function isToday(ts) {
  if (!ts) return false;
  const msgDate = new Date(ts * 1000).toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
  return msgDate === getTodayString();
}

function isYesterday(ts) {
  if (!ts) return false;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
  const msgDate = new Date(ts * 1000).toLocaleDateString('pt-BR', { timeZone: TIMEZONE }).replace(/\//g, '.');
  return msgDate === yesterdayStr;
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getExtensionFromMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
    'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov',
    'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/opus': 'ogg',
    'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/zip': 'zip', 'application/vnd.rar': 'rar',
    'application/x-rar-compressed': 'rar',
    'application/vnd.android.package-archive': 'apk'
  };
  return map[mime] || 'bin';
}

function classifyMedia(type) {
  if (type === 'image' || type === 'sticker') {
    return { type: 'image', folder: 'fotosVideos', prefix: 'Imagem_' };
  }
  if (type === 'video') {
    return { type: 'video', folder: 'fotosVideos', prefix: 'Vídeo_' };
  }
  if (type === 'document') {
    return { type: 'document', folder: 'documentos', prefix: 'Documento_' };
  }
  if (type === 'audio' || type === 'ptt') {
    return { type: 'audio', folder: 'audios', prefix: 'Áudio_' };
  }
  return null;
}

function scanExistingFiles(folders) {
  const dirs = [
    { path: folders.fotosVideos, prefix: 'Imagem_' },
    { path: folders.fotosVideos, prefix: 'Vídeo_' },
    { path: folders.documentos, prefix: 'Documento_' },
    { path: folders.audios, prefix: 'Áudio_' }
  ];

  let maxImagem = 0, maxVideo = 0, maxDocumento = 0, maxAudio = 0;

  for (const { path: dirPath, prefix } of dirs) {
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const match = file.match(new RegExp(`^${prefix.replace(/[\\/]/g, '\\\\')}([0-9]+)\\\\.`));
      if (match) {
        const num = parseInt(match[1], 10);
        if (prefix === 'Imagem_' && num > maxImagem) maxImagem = num;
        if (prefix === 'Vídeo_' && num > maxVideo) maxVideo = num;
        if (prefix === 'Documento_' && num > maxDocumento) maxDocumento = num;
        if (prefix === 'Áudio_' && num > maxAudio) maxAudio = num;
      }
    }
  }

  return { imagem: maxImagem, video: maxVideo, documento: maxDocumento, audio: maxAudio };
}

function syncCacheWithExistingFiles(folders, mediaCache) {
  const allDirs = [folders.fotosVideos, folders.documentos, folders.audios];
  let synced = 0;

  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      const buffer = fs.readFileSync(filePath);
      const hash = hashBuffer(buffer);
      const alreadyCached = Object.values(mediaCache).some(entry => entry.hash === hash);
      if (!alreadyCached) {
        let type = 'recovered';
        if (dir === folders.fotosVideos) {
          type = file.toLowerCase().startsWith('imagem_') ? 'image' : 'video';
        } else if (dir === folders.documentos) {
          type = 'document';
        } else if (dir === folders.audios) {
          type = 'audio';
        }

        const uniqueId = `recovered_${hash.slice(0, 16)}`;
        mediaCache[uniqueId] = {
          groupId: 'unknown',
          participant: 'unknown',
          timestamp: stat.mtime.getTime(),
          type: type,
          hash: hash,
          file: file,
          downloaded: true
        };
        synced++;
      }
    }
  }

  return synced;
}

function generateFileName(mediaInfo, mime, counters) {
  const ext = getExtensionFromMime(mime);
  if (mediaInfo.type === 'image') {
    counters.imagem++;
    return `Imagem_${String(counters.imagem).padStart(3, '0')}.${ext}`;
  }
  if (mediaInfo.type === 'video') {
    counters.video++;
    return `Vídeo_${String(counters.video).padStart(3, '0')}.${ext}`;
  }
  if (mediaInfo.type === 'document') {
    counters.documento++;
    return `Documento_${String(counters.documento).padStart(3, '0')}.${ext}`;
  }
  if (mediaInfo.type === 'audio') {
    counters.audio++;
    return `Áudio_${String(counters.audio).padStart(3, '0')}.${ext}`;
  }
  return null;
}

function updateSharedState(updates) {
  try {
    let state = {};
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
    Object.assign(state, updates);
    writeJsonAtomic(STATE_FILE, state);
  } catch (e) {
    console.error('   ❌ Erro ao atualizar shared_state:', e.message);
  }
}

// ============================================================
// RECOVERY POR OBRA
// ============================================================
async function runRecoveryForObra(client, obra, groupId) {
  const caminho = obra.caminho;
  const cacheFile = path.join(caminho, '.media_index.json');
  const targetDateStr = TARGET_DATE || getTodayString();

  console.log('');
  console.log(`   📡 Processando obra: ${obra.nome || groupId}`);
  console.log(`      Caminho: ${caminho}`);
  console.log(`      📅 Data alvo: ${targetDateStr}${FORCE_DOWNLOAD ? ' (FORÇADO - ignorando cache)' : ''}`);

  // Carregar ou criar cache
  let mediaCache = {};
  try {
    if (fs.existsSync(cacheFile)) {
      mediaCache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      console.log(`      📦 Cache carregado: ${Object.keys(mediaCache).length} entradas.`);
    } else {
      console.log('      📦 Cache vazio.');
    }
  } catch (err) {
    console.error('      ❌ Erro ao carregar cache:', err.message);
    mediaCache = {};
  }

  // ⭐ SE --force, apaga do cache as entradas do dia alvo
  if (FORCE_DOWNLOAD) {
    let removed = 0;
    for (const [key, entry] of Object.entries(mediaCache)) {
      if (entry.timestamp && isDate(Math.floor(entry.timestamp / 1000), targetDateStr)) {
        delete mediaCache[key];
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`      🗑️  ${removed} entradas do cache do dia ${targetDateStr} removidas.`);
    }
  }

  // Preparar estrutura do dia (encontra ou cria "NN - DD.MM.AAAA")
  const folders = createDayStructure(caminho, targetDateStr);
  console.log(`      📁 Pasta do dia: ${path.basename(folders.base)}`);
  const counters = scanExistingFiles(folders);

  // Sincroniza arquivos já existentes no cache
  const synced = syncCacheWithExistingFiles(folders, mediaCache);
  if (synced > 0) {
    console.log(`      🔄 ${synced} arquivo(s) existente(s) sincronizado(s) no cache.`);
    try {
      ensureDir(path.dirname(cacheFile));
      writeJsonAtomic(cacheFile, mediaCache);
    } catch (e) {}
  }

  console.log(`      🔢 Contadores: Img=${counters.imagem}, Vid=${counters.video}, Doc=${counters.documento}, Aud=${counters.audio}`);

  // Acessar grupo
  let targetChat = null;
  try {
    targetChat = await client.getChatById(groupId);
    console.log(`      📂 Grupo acessado: ${targetChat.name}`);
    emitEvent({ module: 'recovery', severity: 'info', eventType: 'group_checked', message: 'Grupo carregado para verificação histórica', groupLabel: obra.nome || targetChat.name || 'grupo configurado' });
  } catch (chatErr) {
    console.error(`      ❌ getChatById falhou: ${chatErr.message}`);
    targetChat = { id: { _serialized: groupId }, name: obra.nome || 'Grupo' };
  }

  // Verifica se o chat tem método fetchMessages
  if (!targetChat.fetchMessages) {
    console.error(`      ❌ Chat não possui fetchMessages. Abortando obra.`);
    return { totalMedia: 0, totalSkipped: 0, totalDownloaded: 0, totalText: 0 };
  }

  // ⭐ ESPERA MAIS TEMPO pro WhatsApp Web carregar o histórico completo
  console.log(`      ⏳ Aguardando ${PRE_FETCH_DELAY_MS/1000}s para WhatsApp Web carregar histórico completo...`);
  await new Promise(r => setTimeout(r, PRE_FETCH_DELAY_MS));

  // ⭐ CARREGA MENSAGENS EM MÚLTIPLAS TENTATIVAS
  let allMessages = [];
  let attempt = 0;

  while (attempt < MAX_FETCH_ATTEMPTS) {
    if (recoveryTimedOut) break;
    attempt++;

    try {
      const batch = await targetChat.fetchMessages({ limit: 500 });
      const currentCount = batch ? batch.length : 0;

      console.log(`      📥 Tentativa ${attempt}/${MAX_FETCH_ATTEMPTS}: ${currentCount} mensagens retornadas.`);
      emitEvent({ module: 'recovery', severity: 'debug', eventType: 'history_batch_checked', message: 'Lote de histórico verificado', groupLabel: obra.nome || targetChat.name || 'grupo configurado', details: { attempt, messagesReturned: currentCount } });

      // Adiciona mensagens novas (evita duplicatas por ID)
      const existingIds = new Set(allMessages.map(m => m.id.id));
      let newMessages = 0;
      let oldestInBatch = null;
      let newestInBatch = null;

      for (const msg of (batch || [])) {
        if (!existingIds.has(msg.id.id)) {
          allMessages.push(msg);
          existingIds.add(msg.id.id);
          newMessages++;

          // Rastreia a mensagem mais antiga e mais nova do lote
          if (!oldestInBatch || msg.timestamp < oldestInBatch.timestamp) {
            oldestInBatch = msg;
          }
          if (!newestInBatch || msg.timestamp > newestInBatch.timestamp) {
            newestInBatch = msg;
          }
        }
      }

      if (oldestInBatch && newestInBatch) {
        console.log(`         📅 Lote: ${formatDateBR(oldestInBatch.timestamp)} ${formatTimestamp(oldestInBatch.timestamp)} → ${formatDateBR(newestInBatch.timestamp)} ${formatTimestamp(newestInBatch.timestamp)}`);
      }

      console.log(`         ➕ ${newMessages} mensagens novas. Total acumulado: ${allMessages.length}`);

      // Se não encontrou mensagens novas, para
      if (newMessages === 0) {
        console.log(`         ⏹️  Sem mensagens novas. Parando.`);
        break;
      }

      // Espera antes da próxima tentativa
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.log(`         ⏳ Aguardando ${FETCH_BATCH_DELAY_MS/1000}s antes da próxima tentativa...`);
        await new Promise(r => setTimeout(r, FETCH_BATCH_DELAY_MS));
      }

    } catch (fetchErr) {
      console.error(`      ❌ fetchMessages falhou na tentativa ${attempt}: ${fetchErr.message}`);
      break;
    }
  }

  console.log(`      ✅ Total de mensagens acumuladas: ${allMessages.length}`);

  if (allMessages.length === 0) {
    return { totalMedia: 0, totalSkipped: 0, totalDownloaded: 0, totalText: 0 };
  }

  // Ordena do mais antigo para o mais novo
  const reversed = [...allMessages].sort((a, b) => a.timestamp - b.timestamp);

  // ⭐ FILTRA APENAS MENSAGENS DO DIA ALVO
  const targetMessages = reversed.filter(msg => isDate(msg.timestamp, targetDateStr));

  console.log(`      📊 Analisando ${targetMessages.length} mensagens do dia ${targetDateStr} (filtradas de ${reversed.length} total)...`);
  emitEvent({ module: 'recovery', severity: 'info', eventType: 'history_ready_for_processing', message: 'Histórico pronto para análise', groupLabel: obra.nome || targetChat.name || 'grupo configurado', details: { messagesLoaded: allMessages.length, targetMessages: targetMessages.length } });

  if (targetMessages.length === 0) {
    console.log(`      ⏹️  Nenhuma mensagem do dia ${targetDateStr} encontrada neste grupo.`);
    return { totalMedia: 0, totalSkipped: 0, totalDownloaded: 0, totalText: 0 };
  }

  // Log da primeira e última mensagem do dia
  const firstMsg = targetMessages[0];
  const lastMsg = targetMessages[targetMessages.length - 1];
  console.log(`      🌅 Primeira mensagem do dia: ${formatDateBR(firstMsg.timestamp)} ${formatTimestamp(firstMsg.timestamp)}`);
  console.log(`      🌙 Última mensagem do dia: ${formatDateBR(lastMsg.timestamp)} ${formatTimestamp(lastMsg.timestamp)}`);

  let totalMedia = 0;
  let totalSkipped = 0;
  let totalDownloaded = 0;
  let totalText = 0;

  for (let i = 0; i < targetMessages.length; i++) {
    if (recoveryTimedOut) break;
    const msg = targetMessages[i];

    const msgChatId = msg.id?.remote || msg.from || '';
    if (msgChatId !== groupId) continue;

    const ts = msg.timestamp;
    const msgTime = formatTimestamp(ts);

    const msgId = msg.id.id;
    if (mediaCache[msgId]) { totalSkipped++; continue; }

    if (msg.hasMedia) {
      const mediaInfo = classifyMedia(msg.type);
      if (!mediaInfo) continue;

      totalMedia++;
      console.log(`   📥 [${i + 1}/${targetMessages.length}] ${msgTime} ${mediaInfo.type.toUpperCase()}: ${msgId.slice(0, 20)}...`);

      try {
        const media = await msg.downloadMedia();
        if (!media || !media.data) {
          console.log('      ❌ downloadMedia vazio.');
          continue;
        }

        const buffer = Buffer.from(media.data, 'base64');
        const hash = hashBuffer(buffer);

        const hashExists = Object.values(mediaCache).some(e => e.hash === hash);
        if (hashExists) {
          console.log('      ✅ Hash já existe. Ignorada.');
          totalSkipped++;
          continue;
        }

        const fileName = generateFileName(mediaInfo, media.mimetype, counters);
        const filePath = path.join(folders[mediaInfo.folder], fileName);
        fs.writeFileSync(filePath, buffer);

        mediaCache[msgId] = {
          groupId: groupId,
          participant: msg.author ? msg.author.replace('@c.us', '') : 'unknown',
          timestamp: ts,
          type: mediaInfo.type,
          hash: hash,
          file: fileName,
          downloaded: true
        };

        console.log(`      💾 Salva: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);
        totalDownloaded++;
      } catch (e) {
        console.error(`      ❌ Erro: ${e.message}`);
      }
    } else if (msg.body && msg.type === 'chat') {
      totalText++;
      const time = formatTimestamp(ts);
      const participant = msg.author ? msg.author.replace('@c.us', '') : 'unknown';
      const entry = `${time}\n${participant}\n${msg.body.trim()}\n--------------------------------\n\n`;
      const transcriptPath = path.join(folders.transcript, 'conversa.txt');
      if (fs.existsSync(transcriptPath)) {
        fs.appendFileSync(transcriptPath, entry, 'utf-8');
      } else {
        fs.writeFileSync(transcriptPath, entry, 'utf-8');
      }
    }
  }

  // Salvar cache
  try {
    ensureDir(path.dirname(cacheFile));
    writeJsonAtomic(cacheFile, mediaCache);
  } catch (err) {
    console.error('      ❌ Erro ao salvar cache:', err.message);
  }

  console.log(`      📊 Resumo obra: Mídias=${totalMedia}, Skipped=${totalSkipped}, Baixadas=${totalDownloaded}, Textos=${totalText}`);

  return { totalMedia, totalSkipped, totalDownloaded, totalText };
}

// ============================================================
// RECOVERY PRINCIPAL
// ============================================================
async function runRecovery() {
  const releaseLock = acquireProcessLock('./.recovery.lock', RECOVERY_TIMEOUT_MS + 60000);
  if (!releaseLock) {
    console.log('ℹ️  Recovery já está sendo executado por outro processo.');
    process.exit(0);
  }
  process.once('exit', releaseLock);
  console.log('');
  console.log('🔄 === MÓDULO DE RECUPERAÇÃO INICIADO ===');
  emitEvent({ module: 'recovery', severity: 'info', eventType: 'recovery_started', message: 'Recovery iniciado' });
  if (TARGET_DATE) {
    console.log(`   📅 Data alvo: ${TARGET_DATE}`);
  } else {
    console.log('   📅 Data alvo: HOJE');
  }
  if (FORCE_DOWNLOAD) {
    console.log('   🗑️  Modo FORÇADO: cache do dia alvo será ignorado');
  }
  console.log('   Usando whatsapp-web.js com fix _serialized');
  console.log(`   Timeout máximo: ${RECOVERY_TIMEOUT_MS/60000} minutos`);
  console.log('   Conectando ao WhatsApp Web...');

  let obras = {};
  try {
    if (fs.existsSync(OBRAS_PATH)) {
      obras = JSON.parse(fs.readFileSync(OBRAS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('❌ Erro ao carregar obras.json:', e.message);
    process.exit(1);
  }

    const obrasAtivas = Object.entries(obras).filter(([_, obra]) => obra.ativo !== false);
  emitEvent({ module: 'recovery', severity: obrasAtivas.length ? 'info' : 'warn', eventType: 'groups_loaded', message: obrasAtivas.length ? 'Grupos ativos carregados para recovery' : 'Nenhum grupo ativo configurado para recovery', details: { activeGroups: obrasAtivas.length } });
  if (obrasAtivas.length === 0) {
    console.log('ℹ️  Nenhuma obra ativa encontrada. Verifique obras.json.');
    process.exit(0);
  }
  console.log(`   Obras ativas para recovery: ${obrasAtivas.length}`);

  const timeoutId = setTimeout(() => {
    recoveryTimedOut = true;
    console.log('');
    console.error('⏱️  TIMEOUT: Recovery excedeu o tempo limite. Forçando encerramento.');
    process.exit(1);
  }, RECOVERY_TIMEOUT_MS);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wweb_auth' }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  client.on('qr', async (qr) => {
    if (recoveryTimedOut) return;
    console.log('');
    console.log('📲 QR Code recebido. Tentando pairing code...');
    try {
      const pairingCode = await client.requestPairingCode(PHONE_NUMBER);
      console.log('');
      console.log('=================================================');
      console.log(`📲 CÓDIGO DE PAREAMENTO: ${pairingCode}`);
      console.log('Abra o WhatsApp no emulador ->');
      console.log('Aparelhos Conectados -> Conectar com Número de Telefone');
      console.log('=================================================');
      console.log('');
    } catch (err) {
      console.log('⚠️  Pairing code falhou. Use o QR Code acima.');
    }
  });

  client.on('loading_screen', (percent, message) => {
    if (recoveryTimedOut) return;
    console.log(`   ⏳ Carregando WhatsApp Web... ${percent}% ${message || ''}`);
  });

  client.on('authenticated', () => {
    if (recoveryTimedOut) return;
    console.log('   🔐 Autenticado com sucesso.');
  });

  client.on('auth_failure', (msg) => {
    if (recoveryTimedOut) return;
    console.error('');
    console.error('❌ Falha na autenticação:', msg);
    updateSharedState({ recovery_status: 'failed', recovery_trigger_reason: 'auth_failure' });
    clearTimeout(timeoutId);
    process.exit(1);
  });

  client.on('ready', async () => {
    if (recoveryTimedOut) return;
    console.log('');
    console.log('✅ WhatsApp Web conectado!');
    if (wasDisconnected) emitEvent({ module: 'recovery', severity: 'info', eventType: 'recovery_reconnected', message: 'Cliente de recovery reconectado' });
    wasDisconnected = false;
    console.log('');
    console.log('====================================');
    console.log('MODO RECOVERY ATIVO');
    console.log(`Obras em recuperação: ${obrasAtivas.length}`);
    console.log('====================================');
    updateSharedState({ recovery_status: 'running' });

    try {
      let grandTotalMedia = 0;
      let grandTotalSkipped = 0;
      let grandTotalDownloaded = 0;
      let grandTotalText = 0;

      for (const [groupId, obra] of obrasAtivas) {
        if (recoveryTimedOut) break;
        emitEvent({ module: 'recovery', severity: 'debug', eventType: 'recovery_progress', message: 'Processando obra no recovery' });
        const res = await runRecoveryForObra(client, obra, groupId);
        grandTotalMedia += res.totalMedia;
        grandTotalSkipped += res.totalSkipped;
        grandTotalDownloaded += res.totalDownloaded;
        grandTotalText += res.totalText;
        emitEvent({ module: 'recovery', severity: 'debug', eventType: 'recovery_progress', message: 'Obra processada no recovery', details: { downloaded: res.totalDownloaded, skipped: res.totalSkipped } });
      }

      console.log('');
      console.log('📊 === RESUMO GERAL DO RECOVERY ===');
      console.log(`   Mídias:     ${grandTotalMedia}`);
      console.log(`   Skipped:    ${grandTotalSkipped}`);
      console.log(`   Baixadas:   ${grandTotalDownloaded}`);
      console.log(`   Textos:     ${grandTotalText}`);
      console.log('   ==================================');

      updateSharedState({ recovery_status: 'completed', recovery_last_run: new Date().toISOString() });
      emitEvent({ module: 'recovery', severity: 'info', eventType: 'recovery_completed', message: 'Recovery concluído' });
      console.log('   ✅ Recovery concluído.');

    } catch (e) {
      console.error('');
      emitEvent({ module: 'recovery', severity: 'error', eventType: 'recovery_error', message: 'Falha no recovery', details: { error: e.message } });
      console.error('❌ Erro:', e.message);
      console.error(e.stack);
      updateSharedState({ recovery_status: 'failed', recovery_trigger_reason: e.message });
    }

    clearTimeout(timeoutId);
    console.log('   Fechando navegador...');
    try { await client.destroy(); console.log('   👋 Navegador fechado.'); } catch (e) {}
    process.exit(0);
  });

  client.on('disconnected', (reason) => {
    wasDisconnected = true;
    emitEvent({ module: 'recovery', severity: 'warn', eventType: 'recovery_disconnected', message: 'Cliente de recovery desconectado', details: { reason: String(reason) } });
    console.log(`   ⚠️  Desconectado: ${reason}`);
  });

  console.log('   🚀 Inicializando...');
  client.initialize().catch(err => {
    console.error('❌ Erro ao inicializar:', err.message);
    clearTimeout(timeoutId);
    process.exit(1);
  });
}

// ============================================================
// ENTRY POINT
// ============================================================
function shouldRun() {
  const manual = process.argv.includes('--manual');
  if (manual) {
    console.log('🛠️  Recovery manual solicitado. A verificação histórica será executada independentemente do estado anterior.');
    return true;
  }
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('ℹ️  shared_state.json não encontrado. Recovery automático não será executado.');
      return false;
    }
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const needs = state.recovery_status === 'needs_recovery';
    if (needs) {
      console.log('🚨 RECUPERAÇÃO NECESSÁRIA');
      console.log(`   Motivo: ${state.recovery_trigger_reason || 'desconhecido'}`);
    }
    return needs;
  } catch (e) {
    console.error('❌ Erro ao ler shared_state:', e.message);
    return false;
  }
}

if (shouldRun()) {
  runRecovery();
} else {
  console.log('ℹ️  Nenhuma recuperação necessária. Saindo.');
  process.exit(0);
}

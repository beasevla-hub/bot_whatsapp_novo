const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mediaWatcher = require('./mediaWatcher');
const router = require('./router');
const { emitEvent } = require('./monitorClient');
const { startDashboard } = require('./dashboardServer');

const APPEND_IDLE_DELAY = 3000; // 3 segundos sem mensagens append = sync terminado
let syncCompleted = false;
let appendIdleTimer = null;
let messageQueue = Promise.resolve();
let persistTimer = null;
let reconnectTimer = null;

// ============================================================
// ENTRY POINT ÚNICO
// ============================================================
async function start() {
  console.log('🤖 Iniciando Bot WhatsApp (Arquivador + Tabelas)...');
  console.log('   Arquitetura: index → Baileys → router → mediaWatcher | tableBot');
  console.log('   Conexão única. Store compartilhada. Módulos isolados.');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    keepAliveIntervalMs: 20000,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    shouldSyncHistoryMessage: (msg) => {
      console.log(`   📜 Sync type recebido: ${msg?.syncType}`);
      return true;
    },
    markOnlineOnConnect: false
  });

  // ── Store persistente (compartilhada entre todos os módulos) ──
  const store = mediaWatcher.setupStore();
  store.bind(sock.ev);

  if (!persistTimer) {
    persistTimer = setInterval(() => mediaWatcher.persistStore(), 10000);
  }

  // ── Inicializa subsistemas ──
  mediaWatcher.init();

  // ── Pairing Code (se não registrado) ──
  if (!sock.authState.creds.registered) {
    const numeroTelefone = '5511947380028';
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(numeroTelefone);
        console.log('');
        console.log('=================================================');
        console.log(`📲 CÓDIGO DE PAREAMENTO: ${code}`);
        console.log('Abra o WhatsApp -> Aparelhos Conectados -> Conectar com Número de Telefone');
        console.log('=================================================');
        console.log('');
      } catch (err) {
        console.log('❌ Erro ao pedir código de pareamento:', err);
      }
    }, 3000);
  }

  // ============================================================
  // EVENTOS DE CONEXÃO
  // ============================================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const lastDisconnectTime = new Date().toISOString();
      mediaWatcher.updateSharedState({
        baileys_status: 'disconnected',
        last_baileys_disconnect: lastDisconnectTime
      });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Conexão caiu (Código: ${statusCode}). Reconectando automaticamente: ${shouldReconnect}`);
      emitEvent({ module: 'baileys', severity: 'warn', eventType: 'connection_closed', message: 'Conexão Baileys encerrada; reconexão avaliada', details: { statusCode, shouldReconnect } });
      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          start().catch(error => console.error('❌ Erro ao reconectar:', error));
        }, 5000);
      } else {
        console.log('⚠️ Você deslogou pelo celular. Delete a pasta auth_info e rode de novo.');
      }
    } else if (connection === 'open') {
      syncCompleted = false;
      console.log('✅ Conexão estabelecida e blindada contra quedas!');
      emitEvent({ module: 'baileys', severity: 'info', eventType: 'connection_open', message: 'Conexão Baileys estabelecida' });
      console.log('   Aguardando sync inicial...');

      const needsRecovery = mediaWatcher.checkIfRecoveryNeeded();
      if (needsRecovery) {
        mediaWatcher.updateSharedState({
          baileys_status: 'online',
          recovery_status: 'needs_recovery',
          recovery_trigger_reason: 'offline_period'
        });
        mediaWatcher.startRecovery();
      } else {
        mediaWatcher.updateSharedState({ baileys_status: 'online', recovery_status: 'idle' });
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ============================================================
  // EVENTOS DE SYNC (disparam o sincronizador de mídia)
  // ============================================================
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType, isLatest }) => {
    console.log('');
    console.log(`📜 messaging-history.set: ${messages?.length || 0} mensagens (isLatest: ${isLatest}, type: ${syncType})`);
    if (isLatest === true && !syncCompleted) {
      syncCompleted = true;
      console.log('   ✅ Sync completo (messaging-history.set). Iniciando sincronizador...');
      await mediaWatcher.runSync(sock);
    }
  });

  sock.ev.on('chats.set', async ({ chats, isLatest }) => {
    console.log(`📜 chats.set: ${chats?.length || 0} chats (isLatest: ${isLatest})`);
    if (isLatest === true && !syncCompleted) {
      syncCompleted = true;
      console.log('   ✅ Sync completo (chats.set). Iniciando sincronizador...');
      await mediaWatcher.runSync(sock);
    }
  });

  sock.ev.on('messages.set', async ({ messages, isLatest }) => {
    console.log(`📜 messages.set: ${messages?.length || 0} mensagens (isLatest: ${isLatest})`);
    if (isLatest === true && !syncCompleted) {
      syncCompleted = true;
      console.log('   ✅ Sync completo (messages.set). Iniciando sincronizador...');
      await mediaWatcher.runSync(sock);
    }
  });

  // ============================================================
  // EVENTO PRINCIPAL: MENSAGENS → ROUTER
  // ============================================================
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify' && type !== 'append') return;

    // Se são mensagens do histórico/offline (append), gerencia o timer de inatividade
    if (type === 'append') {
      if (appendIdleTimer) clearTimeout(appendIdleTimer);
      appendIdleTimer = setTimeout(async () => {
        if (!syncCompleted) {
          syncCompleted = true;
          console.log('');
          console.log('   ✅ Fluxo de mensagens offline encerrado. Iniciando sincronizador...');
          await mediaWatcher.runSync(sock);
        }
      }, APPEND_IDLE_DELAY);
    }

    for (const msg of messages) {
      emitEvent({ module: 'baileys', severity: 'debug', eventType: 'queue_enqueued', message: 'Mensagem adicionada à fila de processamento', details: { batchType: type } });
      messageQueue = messageQueue
        .then(() => {
          emitEvent({ module: 'baileys', severity: 'debug', eventType: 'queue_processing', message: 'Mensagem em processamento' });
          return router.route(sock, msg);
        })
        .catch(error => {
          emitEvent({ module: 'system', severity: 'error', eventType: 'message_processing_error', message: 'Falha no processamento de mensagem', details: { error: error.message } });
          console.error('❌ Erro no processamento da mensagem:', error);
        });
    }
    await messageQueue;
  });
}

startDashboard();
start().catch(error => {
  emitEvent({ module: 'system', severity: 'error', eventType: 'process_error', message: 'Processo principal encerrou com erro', details: { error: error.message } });
  console.error(error);
});

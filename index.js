const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mediaWatcher = require('./mediaWatcher');
const router = require('./router');

const APPEND_IDLE_DELAY = 3000; // 3 segundos sem mensagens append = sync terminado
let syncCompleted = false;
let appendIdleTimer = null;

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

  setInterval(() => {
    mediaWatcher.persistStore();
  }, 10000);

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
      if (shouldReconnect) {
        setTimeout(start, 5000);
      } else {
        console.log('⚠️ Você deslogou pelo celular. Delete a pasta auth_info e rode de novo.');
      }
    } else if (connection === 'open') {
      syncCompleted = false;
      console.log('✅ Conexão estabelecida e blindada contra quedas!');
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
      await router.route(sock, msg);
    }
  });
}

start().catch(console.error);

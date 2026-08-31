const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function listarGrupos() {
  console.log('🔍 Conectando ao WhatsApp para listar grupos...');
  console.log('   (Isso pode levar até 30 segundos...)\n');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  let grupos = [];
  let conectado = false;
  let syncCompleto = false;

  function adicionarGrupos(lista) {
    for (const chat of lista) {
      if (chat.id && chat.id.endsWith('@g.us')) {
        const jaExiste = grupos.some(g => g.id === chat.id);
        if (!jaExiste) {
          grupos.push({ id: chat.id, nome: chat.name || chat.subject || 'Sem nome' });
          console.log(`   ➕ Encontrado: ${chat.name || chat.subject || chat.id}`);
        }
      }
    }
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('❌ Conexão caiu. Tentando reconectar...');
      } else {
        console.log('⚠️ Você deslogou. Delete auth_info e pareie novamente.');
        process.exit(1);
      }
    } else if (connection === 'open') {
      conectado = true;
      console.log('✅ Conectado! Aguardando carregamento dos grupos...\n');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Múltiplos listeners para capturar grupos de diferentes formas
  sock.ev.on('chats.upsert', (chats) => {
    adicionarGrupos(chats);
  });

  sock.ev.on('chats.update', (updates) => {
    adicionarGrupos(updates);
  });

  sock.ev.on('messaging-history.set', ({ chats }) => {
    if (chats) adicionarGrupos(chats);
  });

  sock.ev.on('groups.upsert', (groups) => {
    adicionarGrupos(groups);
  });

  // Também tenta pegar de groupMetadataUpdate
  sock.ev.on('group-metadata.update', (updates) => {
    for (const up of updates) {
      if (up.id && up.id.endsWith('@g.us')) {
        const jaExiste = grupos.some(g => g.id === up.id);
        if (!jaExiste) {
          grupos.push({ id: up.id, nome: up.subject || 'Sem nome' });
          console.log(`   ➕ Encontrado (metadata): ${up.subject || up.id}`);
        }
      }
    }
  });

  // Função que imprime o resultado
  function imprimirResultado() {
    // Deduplica e ordena
    const vistos = new Set();
    const unicos = [];
    for (const g of grupos) {
      if (!vistos.has(g.id)) {
        vistos.add(g.id);
        unicos.push(g);
      }
    }
    unicos.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR', { sensitivity: 'base' }));

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  GRUPOS ENCONTRADOS: ${unicos.length}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    for (const g of unicos) {
      console.log(`📂 ${g.nome}`);
      console.log(`   ID:  "${g.id}"`);
      console.log('');
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  FORMATO JSON PRONTO PARA obras.json:');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('{');
    for (let i = 0; i < unicos.length; i++) {
      const g = unicos[i];
      const virgula = i < unicos.length - 1 ? ',' : '';
      console.log(`    "${g.id}": {`);
      console.log(`        "obra": "",`);
      console.log(`        "nome": "${g.nome}",`);
      console.log(`        "caminho": "",`);
      console.log(`        "ativo": true`);
      console.log(`    }${virgula}`);
    }
    console.log('}');
    console.log('');

    sock.logout().catch(() => {});
    process.exit(0);
  }

  // Timer progressivo: tenta a cada 5s, até 30s no máximo
  let tentativas = 0;
  const maxTentativas = 6; // 6 x 5s = 30s

  const interval = setInterval(() => {
    tentativas++;
    console.log(`   ⏳ Tentativa ${tentativas}/${maxTentativas}... (${grupos.length} grupos encontrados até agora)`);

    // Também tenta buscar via groupFetchAllParticipating se disponível
    if (sock.groupFetchAllParticipating && conectado) {
      sock.groupFetchAllParticipating().then(groups => {
        if (groups) {
          const lista = Object.values(groups);
          adicionarGrupos(lista);
        }
      }).catch(() => {});
    }

    if (grupos.length > 0 || tentativas >= maxTentativas) {
      clearInterval(interval);
      imprimirResultado();
    }
  }, 5000);
}

listarGrupos().catch(err => {
  console.error('❌ Erro:', err);
  process.exit(1);
});

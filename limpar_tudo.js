const fs = require('fs');
const path = require('path');

const OBRAS_PATH = './obras.json';

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  🧹 LIMPEZA COMPLETA PARA RECOVERY');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('Isso vai APAGAR:');
console.log('  ❌ Cache de mídia (.media_index.json) de cada obra');
console.log('  ❌ Arquivos baixados (Fotos, Vídeos, Documentos, Áudios)');
console.log('  ❌ Transcripts');
console.log('  ❌ shared_state.json');
console.log('');
console.log('Isso vai MANTER:');
console.log('  ✅ auth_info/ (autenticação Baileys)');
console.log('  ✅ wweb_auth/ (autenticação recovery)');
console.log('  ✅ obras.json (cadastro das obras)');
console.log('  ✅ database.json, database_orgaos.json');
console.log('  ✅ gerador_pdf.py, sync.js, .env');
console.log('');

// Confirmação
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Tem certeza? Digite SIM para continuar: ', (answer) => {
  if (answer.trim().toUpperCase() !== 'SIM') {
    console.log('❌ Cancelado.');
    rl.close();
    process.exit(0);
  }

  console.log('');
  console.log('🧹 Iniciando limpeza...\n');

  let totalApagado = 0;

  // 1. Apagar shared_state.json
  if (fs.existsSync('./shared_state.json')) {
    fs.unlinkSync('./shared_state.json');
    console.log('  ✅ Apagado: shared_state.json');
    totalApagado++;
  }

  // 2. Para cada obra, apagar cache e arquivos do dia de hoje
  if (fs.existsSync(OBRAS_PATH)) {
    const obras = JSON.parse(fs.readFileSync(OBRAS_PATH, 'utf-8'));

    for (const [groupId, obra] of Object.entries(obras)) {
      if (obra.ativo === false) continue;

      const caminho = obra.caminho;
      console.log(`\n  📁 Obra: ${obra.nome || groupId}`);
      console.log(`     Caminho: ${caminho}`);

      // Apagar cache
      const cacheFile = path.join(caminho, '.media_index.json');
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
        console.log(`     ✅ Apagado: .media_index.json`);
        totalApagado++;
      }

      // Listar e apagar pastas do dia (formato "DD - DD.MM.AAAA")
      if (fs.existsSync(caminho)) {
        const entries = fs.readdirSync(caminho, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            // Padrão: "19 - 04.08.2026" ou similar
            const dirPath = path.join(caminho, entry.name);

            // Apaga recursivamente
            function apagarRecursivo(dir) {
              const items = fs.readdirSync(dir, { withFileTypes: true });
              for (const item of items) {
                const itemPath = path.join(dir, item.name);
                if (item.isDirectory()) {
                  apagarRecursivo(itemPath);
                  fs.rmdirSync(itemPath);
                } else {
                  fs.unlinkSync(itemPath);
                }
              }
            }

            try {
              apagarRecursivo(dirPath);
              fs.rmdirSync(dirPath);
              console.log(`     ✅ Apagado: ${entry.name}/`);
              totalApagado++;
            } catch (e) {
              console.log(`     ⚠️  Erro ao apagar ${entry.name}: ${e.message}`);
            }
          }
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Limpeza concluída. ${totalApagado} item(s) apagado(s).`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('👉 Agora você pode rodar:');
  console.log('   node forcar_recovery.js');
  console.log('   node recovery.js');
  console.log('');
  console.log('   Ele vai baixar TUDO de novo como se fosse a primeira vez.');
  console.log('');

  rl.close();
});

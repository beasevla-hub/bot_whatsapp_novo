const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, getFoldersForDay } = require('./utils');

const OBRAS_PATH = './obras.json';

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function scanObra(groupId, obra) {
  const caminho = obra.caminho;
  const cacheFile = path.join(caminho, '.media_index.json');
  const folders = getFoldersForDay(caminho);

  console.log(`\n📁 Obra: ${obra.nome || groupId}`);
  console.log(`   Caminho base: ${caminho}`);
  console.log(`   Pasta do dia: ${path.basename(folders.base)}`);

  // Carregar cache existente
  let mediaCache = {};
  try {
    if (fs.existsSync(cacheFile)) {
      mediaCache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      console.log(`   📦 Cache atual: ${Object.keys(mediaCache).length} entradas`);
    }
  } catch (e) {
    console.log('   ⚠️  Cache corrompido. Criando novo.');
  }

  const allDirs = [folders.fotosVideos, folders.documentos, folders.audios];
  let scanned = 0;
  let added = 0;

  for (const dir of allDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      scanned++;
      const buffer = fs.readFileSync(filePath);
      const hash = hashBuffer(buffer);

      const alreadyCached = Object.values(mediaCache).some(entry => entry.hash === hash);
      if (alreadyCached) continue;

      let type = 'unknown';
      if (dir === folders.fotosVideos) {
        type = file.toLowerCase().startsWith('imagem_') ? 'image' : 'video';
      } else if (dir === folders.documentos) {
        type = 'document';
      } else if (dir === folders.audios) {
        type = 'audio';
      }

      const uniqueId = `manual_${hash.slice(0, 16)}`;

      mediaCache[uniqueId] = {
        groupId: groupId,
        participant: 'manual',
        timestamp: stat.mtime.getTime(),
        type: type,
        hash: hash,
        file: file,
        downloaded: true
      };

      added++;
    }
  }

  ensureDir(path.dirname(cacheFile));
  fs.writeFileSync(cacheFile, JSON.stringify(mediaCache, null, 2));

  console.log(`   🔍 Arquivos escaneados: ${scanned}`);
  console.log(`   ➕ Novos registrados no cache: ${added}`);
  console.log(`   📦 Total no cache: ${Object.keys(mediaCache).length}`);
}

async function main() {
  console.log('🔧 SCAN MANUAL — Registrando arquivos já salvos no cache');

  if (!fs.existsSync(OBRAS_PATH)) {
    console.error('❌ obras.json não encontrado.');
    process.exit(1);
  }

  const obras = JSON.parse(fs.readFileSync(OBRAS_PATH, 'utf-8'));
  const ativas = Object.entries(obras).filter(([_, o]) => o.ativo !== false);

  console.log(`   Obras ativas: ${ativas.length}`);

  for (const [groupId, obra] of ativas) {
    await scanObra(groupId, obra);
  }

  console.log('\n✅ Scan manual concluído.');
  console.log('   Agora você pode rodar o recovery.js com segurança.');
  console.log('   Ele vai ignorar os arquivos já salvos (hash match).');
}

main().catch(console.error);

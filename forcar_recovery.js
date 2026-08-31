const fs = require('fs');

const STATE_FILE = './shared_state.json';

console.log('🚨 FORÇANDO RECOVERY MANUAL');
console.log('');

// Grava o estado que o recovery.js procura
const state = {
  baileys_status: 'disconnected',
  last_baileys_disconnect: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min atrás
  recovery_status: 'needs_recovery',
  recovery_trigger_reason: 'manual_forced'
};

fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

console.log('✅ Estado gravado em shared_state.json');
console.log('   recovery_status: needs_recovery');
console.log('   Motivo: manual_forced');
console.log('');
console.log('👉 Agora rode:');
console.log('   node recovery.js');
console.log('');
console.log('   Quando terminar, volte a rodar:');
console.log('   node index.js');

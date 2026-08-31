const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const LOG_PATH = path.resolve(process.env.MONITOR_LOG_PATH || './monitor_events.jsonl');
const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|session|credential|api.?key|path|cwd|auth|qr)/i;
let writeChain = Promise.resolve();

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/(?:Bearer\s+|token|secret|password|authorization|cookie|session|credential|api.?key)\s*[:=]?\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\n]+/g, '[redacted-path]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanValue(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return cleanText(value, 500);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, item]) => [key, cleanValue(item, depth + 1)]));
}

function sanitizeEvent(event) {
  return {
    occurredAt: new Date().toISOString(),
    module: cleanText(event.module, 32) || 'system',
    severity: ['debug', 'info', 'warn', 'error'].includes(event.severity) ? event.severity : 'info',
    eventType: cleanText(event.eventType, 64) || 'unknown',
    groupLabel: cleanText(event.groupLabel, 160),
    senderLabel: cleanText(event.senderLabel, 120),
    mediaLabel: cleanText(event.mediaLabel, 180),
    message: cleanText(event.message, 4000) || '[evento sem mensagem]',
    details: cleanValue(event.details) || {},
  };
}

function emitEvent(event) {
  const safeEvent = sanitizeEvent(event);
  writeChain = writeChain.then(async () => {
    await fs.promises.appendFile(LOG_PATH, JSON.stringify(safeEvent) + '\n', 'utf8');
  }).catch(() => {});
}

function readEvents(limit = 300) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.min(limit, 1000)).map(line => JSON.parse(line)).reverse();
  } catch (_) {
    return [];
  }
}

module.exports = { emitEvent, readEvents, LOG_PATH, sanitizeEvent };

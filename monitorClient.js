const https = require('https');
const http = require('http');
const dotenv = require('dotenv');

dotenv.config();

const MONITOR_URL = process.env.MONITOR_URL;
const MONITOR_SECRET = process.env.MONITOR_INGEST_SECRET;
const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|session|credential|api.?key|path|cwd|auth|qr)/i;

function clean(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.replace(/[\\r\\n]+/g, ' ').replace(/[A-Za-z]:\\[^ ]+/g, '[redacted]').slice(0, 500);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
}

function emitEvent(event) {
  if (!MONITOR_URL || !MONITOR_SECRET) return;
  try {
    const target = new URL('/api/monitoring/events', MONITOR_URL);
    const body = JSON.stringify({ ...event, details: clean(event.details) });
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-monitor-ingest-secret': MONITOR_SECRET },
      timeout: 3000,
    });
    request.on('error', () => {});
    request.on('timeout', () => request.destroy());
    request.end(body);
  } catch (_) {}
}

module.exports = { emitEvent };

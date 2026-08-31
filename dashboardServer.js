const http = require('http');
const fs = require('fs');
const path = require('path');
const { readEvents, LOG_PATH } = require('./monitorClient');

const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'dashboard');

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function filteredEvents(url) {
  const query = url.searchParams;
  const module = query.get('module');
  const severity = query.get('severity');
  const group = query.get('group');
  const search = (query.get('search') || '').toLowerCase();
  const from = query.get('from') ? new Date(`${query.get('from')}T00:00:00`).getTime() : 0;
  const to = query.get('to') ? new Date(`${query.get('to')}T23:59:59`).getTime() : Infinity;
  const offset = Math.max(Number(query.get('offset') || 0), 0);
  const limit = Math.min(Math.max(Number(query.get('limit') || 50), 1), 100);
  const all = readEvents(1000).filter(event => {
    const occurred = new Date(event.occurredAt).getTime();
    const haystack = `${event.eventType} ${event.message} ${event.groupLabel || ''} ${event.senderLabel || ''}`.toLowerCase();
    return (!module || module === 'all' || event.module === module) && (!severity || severity === 'all' || event.severity === severity) && (!group || (event.groupLabel || '').toLowerCase().includes(group.toLowerCase())) && (!search || haystack.includes(search)) && occurred >= from && occurred <= to;
  });
  const items = all.slice(offset, offset + limit);
  return { items, hasMore: offset + limit < all.length, nextOffset: offset + items.length, total: all.length };
}

function health() {
  const events = readEvents(1000);
  const modules = ['baileys', 'recovery', 'tablebot', 'notion'];
  const latestByModule = Object.fromEntries(modules.map(module => [module, events.find(event => event.module === module) || null]));
  const recentFailures = events.filter(event => event.severity === 'error').slice(0, 5);
  const queue = events.find(event => event.eventType.includes('queue'));
  const recovery = events.find(event => event.module === 'recovery');
  const hourAgo = Date.now() - 3600000;
  return { latestByModule, eventsLastHour: events.filter(event => new Date(event.occurredAt).getTime() >= hourAgo).length, warnings: events.filter(event => event.severity === 'warn').length, errors: events.filter(event => event.severity === 'error').length, lastActivityAt: events[0]?.occurredAt || null, queueStatus: queue?.message || 'Sem sinal de fila', recoveryStatus: recovery?.message || 'Sem execução recente', recentFailures, logPath: path.basename(LOG_PATH) };
}

function startDashboard() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/events') return json(res, 200, filteredEvents(url));
    if (url.pathname === '/api/health') return json(res, 200, health());
    if (url.pathname === '/api/status') return json(res, 200, { ok: true, dashboard: 'local', port: DASHBOARD_PORT });
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) return json(res, 403, { error: 'forbidden' });
    fs.readFile(filePath, (error, data) => {
      if (error) return json(res, 404, { error: 'not_found' });
      const contentType = filePath.endsWith('.css') ? 'text/css' : filePath.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  server.listen(DASHBOARD_PORT, '127.0.0.1', () => console.log(`[Dashboard] Central local em http://127.0.0.1:${DASHBOARD_PORT}`));
  return server;
}

module.exports = { startDashboard };

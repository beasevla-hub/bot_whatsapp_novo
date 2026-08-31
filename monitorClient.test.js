const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeEvent } = require('./monitorClient');

test('sanitizeEvent redacts credentials and filesystem paths', () => {
  const event = sanitizeEvent({
    module: 'system',
    severity: 'error',
    eventType: 'failure',
    message: 'token=abc123 em C:\\Users\\bot\\auth_info',
    details: { password: 'hidden', safe: 'kept', path: 'C:\\secret' },
  });
  assert.equal(event.module, 'system');
  assert.equal(event.severity, 'error');
  assert.ok(!event.message.includes('abc123'));
  assert.ok(!event.message.includes('Users'));
  assert.equal(event.details.safe, 'kept');
  assert.equal(event.details.password, undefined);
  assert.equal(event.details.path, undefined);
});

test('sanitizeEvent normalizes unsupported values', () => {
  const event = sanitizeEvent({ module: 'unknown', severity: 'verbose', message: 'ok' });
  assert.equal(event.module, 'unknown');
  assert.equal(event.severity, 'info');
  assert.equal(event.eventType, 'unknown');
});

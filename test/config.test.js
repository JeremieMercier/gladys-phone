import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  normalizeBaseUrl,
  deriveGladysUrl,
  effectiveGladysUrl,
  DEFAULT_CONFIG,
} from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeBaseUrl trims and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl(' http://192.168.1.10/ '), 'http://192.168.1.10');
  assert.equal(
    normalizeBaseUrl('https://gladys.example.com/base/'),
    'https://gladys.example.com/base',
  );
});

test('normalizeBaseUrl rejects invalid or non-http values', () => {
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(undefined), '');
  assert.equal(normalizeBaseUrl('not a url'), '');
  assert.equal(normalizeBaseUrl('ftp://192.168.1.10'), '');
});

test('deriveGladysUrl keeps the host API hostname and drops its port', () => {
  assert.equal(deriveGladysUrl('http://172.20.0.2:1443'), 'http://172.20.0.2');
  assert.equal(deriveGladysUrl('http://gladys:1443'), 'http://gladys');
  assert.equal(deriveGladysUrl(undefined), '');
  assert.equal(deriveGladysUrl('nope'), '');
});

test('effectiveGladysUrl prefers the user config over the derivation', () => {
  const env = { GLADYS_HOST_API_URL: 'http://172.20.0.2:1443' };
  assert.equal(
    effectiveGladysUrl(normalizeConfig({ instance_url: 'http://192.168.1.10' }), env),
    'http://192.168.1.10',
  );
  assert.equal(effectiveGladysUrl(normalizeConfig(), env), 'http://172.20.0.2');
  assert.equal(effectiveGladysUrl(normalizeConfig(), {}), '');
});

// Tests du buffer d'états : dédup, caps, drain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatesBuffer, MAX_DEVICES, MAX_READINGS_PER_DEVICE } from '../src/statesBuffer.js';

const silentLog = { info() {}, warn() {}, error() {} };

const reading = (sensor, value, recordedAt) => ({ sensor, value, recorded_at: recordedAt });

test('accepts readings and drains them with device meta', () => {
  const buffer = createStatesBuffer({ log: silentLog });
  const result = buffer.add('phone-1', { name: 'iPhone de J' }, [
    reading('battery-level', 87, '2026-08-15T10:00:00Z'),
    reading('battery-charging', 1, '2026-08-15T10:00:00Z'),
  ]);

  assert.deepEqual(result, { accepted: 2, dropped: 0 });
  assert.equal(buffer.size(), 2);

  const drained = buffer.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].deviceId, 'phone-1');
  assert.deepEqual(drained[0].device, { name: 'iPhone de J' });
  assert.equal(drained[0].readings.length, 2);
  assert.equal(buffer.size(), 0);
  assert.deepEqual(buffer.drain(), []);
});

test('deduplicates on (sensor, recorded_at) so app retries are neutral', () => {
  const buffer = createStatesBuffer({ log: silentLog });
  buffer.add('phone-1', {}, [reading('battery-level', 87, '2026-08-15T10:00:00Z')]);
  const retry = buffer.add('phone-1', {}, [reading('battery-level', 87, '2026-08-15T10:00:00Z')]);

  assert.deepEqual(retry, { accepted: 0, dropped: 0 });
  assert.equal(buffer.size(), 1);
});

test('merges device meta across batches, last non-empty value wins', () => {
  const buffer = createStatesBuffer({ log: silentLog });
  buffer.add('phone-1', { name: 'iPhone' }, [reading('battery-level', 87, '2026-08-15T10:00:00Z')]);
  buffer.add('phone-1', { model: 'iPhone15,2' }, [
    reading('battery-level', 86, '2026-08-15T10:15:00Z'),
  ]);

  const [entry] = buffer.drain();
  assert.deepEqual(entry.device, { name: 'iPhone', model: 'iPhone15,2' });
});

test('caps readings per device by dropping the oldest', () => {
  const lines = [];
  const buffer = createStatesBuffer({ log: { ...silentLog, warn: (msg) => lines.push(msg) } });

  const readings = Array.from({ length: MAX_READINGS_PER_DEVICE + 3 }, (_, i) =>
    reading('battery-level', i, `2026-08-15T10:00:${String(i).padStart(2, '0')}.${i}Z`),
  );
  const result = buffer.add('phone-1', {}, readings);

  assert.equal(result.accepted, MAX_READINGS_PER_DEVICE + 3);
  assert.equal(result.dropped, 3);
  assert.equal(buffer.size(), MAX_READINGS_PER_DEVICE);
  assert.match(lines.at(-1), /dropped 3 oldest/);

  const [entry] = buffer.drain();
  // Les plus anciens sont partis : le premier relevé restant est l'index 3.
  assert.equal(entry.readings[0].value, 3);
});

test('caps the number of devices and drops batches for extra ones', () => {
  const lines = [];
  const buffer = createStatesBuffer({ log: { ...silentLog, warn: (msg) => lines.push(msg) } });

  for (let i = 0; i < MAX_DEVICES; i += 1) {
    buffer.add(`phone-${i}`, {}, [reading('battery-level', 50, '2026-08-15T10:00:00Z')]);
  }
  const overflow = buffer.add('phone-extra', {}, [
    reading('battery-level', 50, '2026-08-15T10:00:00Z'),
  ]);

  assert.deepEqual(overflow, { accepted: 0, dropped: 1 });
  assert.match(lines.at(-1), /buffer full/);
  // Un device déjà connu continue d'accepter des relevés.
  const known = buffer.add('phone-0', {}, [reading('battery-level', 49, '2026-08-15T10:05:00Z')]);
  assert.deepEqual(known, { accepted: 1, dropped: 0 });
});

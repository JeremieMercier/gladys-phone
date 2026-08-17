// Tests du mapping capteur → feature Gladys : verrouille la structure publiée
// en découverte (catégories/types vérifiés dans le core Gladys).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSOR_FEATURES,
  buildPhoneDevice,
  featureExternalId,
  phoneDeviceName,
} from '../src/sensors.js';

/** Faux SDK : reproduit le format documenté ext:<selector>:<type>:<platformId>. */
const fakeGladys = {
  externalIds: (type, platformId) => ({
    device: `ext:tracks:${type}:${platformId}`,
    feature: (key) => `ext:tracks:${type}:${platformId}:${key}`,
  }),
};

test('battery level maps to the Gladys battery category', () => {
  const feature = SENSOR_FEATURES['battery-level'];
  assert.equal(feature.category, 'battery');
  assert.equal(feature.type, 'integer');
  assert.equal(feature.unit, 'percent');
  assert.equal(feature.min, 0);
  assert.equal(feature.max, 100);
});

test('battery charging is a read-only binary sensor, never a switch', () => {
  const feature = SENSOR_FEATURES['battery-charging'];
  assert.equal(feature.category, 'unknown');
  assert.equal(feature.type, 'binary');
  assert.equal(feature.min, 0);
  assert.equal(feature.max, 1);
});

test('buildPhoneDevice publishes every feature of the table', () => {
  const device = buildPhoneDevice(fakeGladys, 'abc-123', {
    name: 'iPhone de J',
    model: 'iPhone15,2',
  });

  assert.equal(device.name, 'iPhone de J');
  assert.equal(device.model, 'iPhone15,2');
  assert.equal(device.external_id, 'ext:tracks:phone:abc-123');
  assert.equal(device.features.length, Object.keys(SENSOR_FEATURES).length);

  for (const feature of device.features) {
    assert.equal(feature.read_only, true);
    assert.equal(feature.has_feedback, false);
    assert.equal(feature.keep_history, true);
    assert.equal(typeof feature.min, 'number');
    assert.equal(typeof feature.max, 'number');
    assert.match(feature.external_id, /^ext:tracks:phone:abc-123:[a-z0-9-]+$/);
  }
});

test('phoneDeviceName falls back to a short id when the phone has no name', () => {
  assert.equal(phoneDeviceName('abcdefgh-1234', {}), 'Gladys Phone abcdefgh');
  assert.equal(phoneDeviceName('abcdefgh-1234', { name: 'Pixel de J' }), 'Pixel de J');
});

test('featureExternalId is stable for known sensors and null for unknown ones', () => {
  assert.equal(
    featureExternalId(fakeGladys, 'abc-123', 'battery-level'),
    'ext:tracks:phone:abc-123:battery-level',
  );
  assert.equal(featureExternalId(fakeGladys, 'abc-123', 'future-sensor'), null);
});

// -----------------------------------------------------------------------------
// Cohérence entre `gladys-assistant-integration.json` et le code : le store
// valide le manifeste, mais lui seul ne peut pas savoir quels handlers le code
// enregistre réellement — ces tests gardent les deux synchronisés.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('manifest version and docker images stay aligned with package.json', () => {
  assert.equal(manifest.version, pkg.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${pkg.version}`),
    'root docker_image tag must match the version',
  );
  for (const container of manifest.containers ?? []) {
    assert.ok(
      container.docker_image.endsWith(`:${pkg.version}`),
      `container "${container.name}" docker_image tag must match the version`,
    );
  }
});

// Actions enregistrées dans index.js.
const REGISTERED_ACTIONS = ['check_health'];

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      REGISTERED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema value fields stay consistent with DEFAULT_CONFIG', () => {
  const valueFields = manifest.config_schema.filter((f) => f.type !== 'section');
  for (const field of valueFields) {
    assert.ok(field.key in DEFAULT_CONFIG, `DEFAULT_CONFIG misses "${field.key}"`);
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('the receiver sub-container declares the beacon port used by the docs', () => {
  const receiver = (manifest.containers ?? []).find((c) => c.name === 'receiver');
  assert.ok(receiver, 'the manifest must declare the "receiver" sub-container');
  assert.deepEqual(receiver.command, ['node', 'receiver.js']);
  assert.equal(
    receiver.start,
    'manual',
    'the main container starts the receiver after reading the config',
  );
  const beaconPort = (receiver.ports ?? []).find((p) => p.name === 'beacon');
  assert.ok(beaconPort, 'the {{port:beacon}} placeholder needs a port named "beacon"');
  assert.equal(beaconPort.container_port, 8080, 'receiver.js listens on 8080 by default');
  assert.equal(beaconPort.browsable, false, 'the beacon endpoint serves no web UI');
});

test('section fields are purely presentational', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

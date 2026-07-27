'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    defaultOutputRoot,
    discoverResourceFolders,
    outputForResource,
} = require('../src/discover');

test('discovers only folders with a .fxap control file', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-discover-test-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));

    const resourceA = path.join(root, 'group', 'resource_a');
    const resourceB = path.join(root, 'resource_b');
    const streamOnly = path.join(root, 'stream_only');
    fs.mkdirSync(resourceA, { recursive: true });
    fs.mkdirSync(resourceB, { recursive: true });
    fs.mkdirSync(streamOnly, { recursive: true });
    fs.writeFileSync(path.join(resourceA, '.fxap'), 'x');
    fs.writeFileSync(path.join(resourceB, '.fxap'), 'x');
    fs.writeFileSync(path.join(streamOnly, 'model.ydr'), 'FXAP');

    assert.deepEqual(discoverResourceFolders(root), [resourceA, resourceB]);
    const outputRoot = defaultOutputRoot(root);
    assert.equal(
        outputForResource(root, outputRoot, resourceA),
        path.join(outputRoot, 'group', 'resource_a'),
    );
});

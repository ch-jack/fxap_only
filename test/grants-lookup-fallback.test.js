'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_KEY, FXAP_HEADER } = require('../src/constants');
const { chacha20 } = require('../src/crypto');
const { FxapDecryptor } = require('../src/decryptor');

function createResource(root, resourceId) {
    const resource = path.join(root, 'resource');
    fs.mkdirSync(resource, { recursive: true });
    const nonce = Buffer.alloc(12, 0x31);
    const cleartext = Buffer.alloc(100);
    cleartext.writeUInt32BE(resourceId, 74);
    const encrypted = chacha20(DEFAULT_KEY, nonce, cleartext);
    const payload = Buffer.alloc(86 + encrypted.length);
    FXAP_HEADER.copy(payload, 0);
    nonce.copy(payload, 74);
    encrypted.copy(payload, 86);
    fs.writeFileSync(path.join(resource, '.fxap'), payload);
    return resource;
}

function createDecryptor(root, log) {
    return new FxapDecryptor({
        grantsLookup: async () => {
            throw new Error('lookup offline');
        },
        log,
        outputDir: path.join(root, 'output'),
        tempDir: path.join(root, 'temp'),
    });
}

test('continues with a local grant when the grants API lookup fails', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-grants-local-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const resourceId = 321;
    const logs = [];
    const stats = await createDecryptor(root, (message) => logs.push(message)).decryptResource(
        createResource(root, resourceId),
        { grants: { [resourceId]: 'ab'.repeat(32) }, grants_clk: {} },
    );

    assert.equal(stats.failed, 0);
    assert.equal(logs.some((message) => message.includes('lookup warning')), true);
});

test('fails the resource when lookup fails and no local key material exists', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-grants-empty-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));

    await assert.rejects(
        createDecryptor(root, () => {}).decryptResource(
            createResource(root, 654),
            { grants: {}, grants_clk: {} },
        ),
        /Keymaster grants API lookup failed for resource 654: lookup offline/,
    );
});

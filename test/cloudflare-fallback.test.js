'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_KEY, FXAP_HEADER } = require('../src/constants');
const { chacha20 } = require('../src/crypto');
const { FxapDecryptor } = require('../src/decryptor');

function outerWrap(cleartext, nonceByte) {
    const nonce = Buffer.alloc(12, nonceByte);
    const encrypted = chacha20(DEFAULT_KEY, nonce, cleartext);
    const output = Buffer.alloc(86 + encrypted.length);
    FXAP_HEADER.copy(output, 0);
    nonce.copy(output, 74);
    encrypted.copy(output, 86);
    return output;
}

function innerWrap(cleartext, key, name, nonceByte) {
    const fileName = Buffer.from(name);
    const nonce = Buffer.alloc(12, nonceByte);
    const header = Buffer.alloc(6 + fileName.length + nonce.length);
    header.write('DATA', 0, 'ascii');
    header.writeUInt16LE(fileName.length, 4);
    fileName.copy(header, 6);
    nonce.copy(header, 6 + fileName.length);
    return Buffer.concat([header, chacha20(key, nonce, cleartext)]);
}

test('decrypts with grants API data when no CFX grant exists', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-cloudflare-fallback-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const resource = path.join(root, 'resource');
    const output = path.join(root, 'output');
    fs.mkdirSync(resource, { recursive: true });

    const resourceId = 123456;
    const grantsClk = Buffer.from([...Array(48).keys()]);
    const derivedKey = Buffer.alloc(32, 0xa5);
    const remoteGrant = Buffer.alloc(32, 0x3c);
    const control = Buffer.alloc(100);
    control.writeUInt32BE(resourceId, 74);
    fs.writeFileSync(path.join(resource, '.fxap'), outerWrap(control, 1));

    const plaintext = Buffer.concat([Buffer.from('RSC7'), Buffer.alloc(32, 0x7e)]);
    fs.writeFileSync(
        path.join(resource, 'asset.ytd'),
        outerWrap(innerWrap(plaintext, derivedKey, 'asset.ytd', 2), 3),
    );

    const lookups = [];
    const derivations = [];
    const grantsPayload = { grants: {}, grants_clk: {} };
    const decryptor = new FxapDecryptor({
        clientKeyDeriver: async (id, clockHex) => {
            derivations.push([id, clockHex]);
            return derivedKey.toString('hex');
        },
        grantsLookup: async (id) => {
            lookups.push(id);
            return {
                resourceId: id,
                grants: remoteGrant.toString('hex'),
                grants_clk: grantsClk.toString('hex'),
            };
        },
        log: () => {},
        outputDir: output,
        tempDir: path.join(root, 'temp'),
    });
    const stats = await decryptor.decryptResource(resource, grantsPayload);

    assert.deepEqual(lookups, [String(resourceId)]);
    assert.deepEqual(derivations, [
        [String(resourceId), grantsClk.toString('hex')],
    ]);
    assert.equal(grantsPayload.grants[String(resourceId)], remoteGrant.toString('hex'));
    assert.equal(
        grantsPayload.grants_clk[String(resourceId)], grantsClk.toString('hex'),
    );
    assert.equal(stats.failed, 0);
    assert.equal(stats.decrypted, 1);
    assert.deepEqual(fs.readFileSync(path.join(output, 'asset.ytd')), plaintext);
});

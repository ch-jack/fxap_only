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

test('decrypts a synthetic FXAP resource, copies plain files, and decompiles Lua', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-core-test-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const resource = path.join(root, 'resource');
    const output = path.join(root, 'output');
    const temp = path.join(root, 'temp');
    fs.mkdirSync(resource, { recursive: true });

    const resourceId = 123456;
    const grant = Buffer.from([...Array(32).keys()]);
    const grantsClk = Buffer.from([...Array(48).keys()]);
    const control = Buffer.alloc(100);
    control.writeUInt32BE(resourceId, 74);
    fs.writeFileSync(path.join(resource, '.fxap'), outerWrap(control, 1));
    fs.writeFileSync(path.join(resource, 'fxmanifest.lua'), 'fx_version \'cerulean\'\n');

    const json = Buffer.from('{"ok":true}\n');
    fs.writeFileSync(
        path.join(resource, 'data.json'),
        outerWrap(innerWrap(json, grant, 'data.json', 2), 3),
    );

    const rsc = Buffer.concat([Buffer.from('RSC7'), Buffer.alloc(64, 9)]);
    fs.writeFileSync(
        path.join(resource, 'model.ydr'),
        outerWrap(innerWrap(rsc, grant, 'model.ydr', 4), 5),
    );

    const luaBytecode = Buffer.concat([Buffer.from([0x1b, 0x4c, 0x75, 0x61]), Buffer.alloc(64, 7)]);
    fs.writeFileSync(
        path.join(resource, 'client.lua'),
        outerWrap(innerWrap(luaBytecode, grant, 'client.lua', 6), 7),
    );

    const decompiler = {
        async decompile(bytecode, outputPath) {
            assert.deepEqual(bytecode, luaBytecode);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, '-- decompiled test\n');
            return { success: true, usedRepair: false };
        },
    };
    const decryptor = new FxapDecryptor({ decompiler, log: () => {}, outputDir: output, tempDir: temp });
    const stats = await decryptor.decryptResource(resource, {
        grants: { [resourceId]: grant.toString('hex') },
        grants_clk: { [resourceId]: grantsClk.toString('hex') },
    });

    assert.equal(fs.readFileSync(path.join(output, 'data.json'), 'utf8'), json.toString('utf8'));
    assert.deepEqual(fs.readFileSync(path.join(output, 'model.ydr')), rsc);
    assert.equal(fs.readFileSync(path.join(output, 'client.lua'), 'utf8'), '-- decompiled test\n');
    assert.equal(fs.readFileSync(path.join(output, 'fxmanifest.lua'), 'utf8'), 'fx_version \'cerulean\'\n');
    assert.equal(fs.existsSync(path.join(output, '.fxap')), false);
    assert.deepEqual(
        {
            copied: stats.copied,
            decrypted: stats.decrypted,
            failed: stats.failed,
            luaDecompiled: stats.luaDecompiled,
        },
        { copied: 1, decrypted: 3, failed: 0, luaDecompiled: 1 },
    );
});

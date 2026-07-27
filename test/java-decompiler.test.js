'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { javaCandidates } = require('../src/java-decompiler');

test('builds candidates for a Java root directory', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-java-path-test-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', executable), 'test');

    assert.equal(javaCandidates(root)[0], path.join(root, 'bin', executable));
});

test('rejects a missing explicit Java path', () => {
    const missing = path.join(os.tmpdir(), `missing-java-${process.pid}-${Date.now()}`);
    assert.throws(() => javaCandidates(missing), /Java path does not exist/);
});

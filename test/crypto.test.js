'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chacha20 } = require('../src/crypto');

test('Node ChaCha20 layout matches the original package behavior', () => {
    const key = Buffer.from([...Array(32).keys()]);
    const nonce = Buffer.from('000102030405060708090a0b', 'hex');
    const input = Buffer.from([...Array(128).keys()]);
    const output = chacha20(key, nonce, input);
    assert.equal(output.subarray(0, 16).toString('hex'), '103bf312c58e529a312d85bb716dcc95');
    assert.deepEqual(chacha20(key, nonce, output), input);
});

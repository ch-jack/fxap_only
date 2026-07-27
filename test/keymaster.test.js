'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeJwtPayload, fetchGrants } = require('../src/keymaster');

function tokenFor(payload) {
    return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('decodes a base64url Keymaster grants token', () => {
    const payload = { grants: { 10: 'aa' }, grants_clk: { 10: 'bb' } };
    assert.deepEqual(decodeJwtPayload(tokenFor(payload)), payload);
});

test('fetchGrants uses the official response payload without persisting it', async () => {
    const payload = { grants: { 10: 'aa' }, grants_clk: { 10: 'bb' } };
    let requestedUrl = null;
    const result = await fetchGrants('cfxk_test', {
        fetchImpl: async (url) => {
            requestedUrl = url;
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, grants_token: tokenFor(payload) }),
            };
        },
    });
    assert.deepEqual(result, payload);
    assert.match(requestedUrl, /^https:\/\/keymaster\.fivem\.net\/api\/validate\/cfxk_test$/);
});

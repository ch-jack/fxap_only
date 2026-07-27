'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    deriveClientKey,
    parseEnvText,
    readLocalEnvironment,
    resolveCloudflareConfig,
} = require('../src/cloudflare-grants');

const TEST_CLK = 'ab'.repeat(48);
const TEST_KEY = 'cd'.repeat(32);

test('parses ignored local environment files without mutating process.env', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-cloudflare-env-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, '# local\nCK_CLIENT_KEY_API_URL="https://derive.example"\n');

    assert.equal(readLocalEnvironment(envFile).CK_CLIENT_KEY_API_URL, 'https://derive.example');
    assert.equal(parseEnvText('A=one\nB=\'two\'\n').B, 'two');
});

test('prefers explicit Cloudflare configuration', () => {
    assert.deepEqual(resolveCloudflareConfig({
        baseUrl: 'https://example.com/',
        environment: {},
    }), {
        baseUrl: 'https://example.com',
    });
});

test('derives the client key through Cloudflare using the dump-tool protocol', async () => {
    let requestUrl;
    let requestOptions;
    const result = await deriveClientKey('7033', TEST_CLK, {
        baseUrl: 'https://example.com',
        environment: {},
        fetchImpl: async (url, options) => {
            requestUrl = url;
            requestOptions = options;
            return new Response(JSON.stringify({ resourceId: 7033, key: TEST_KEY }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(result, TEST_KEY);
    assert.equal(requestUrl, 'https://example.com/v1/derive');
    assert.equal(requestOptions.method, 'POST');
    assert.equal(requestOptions.headers.authorization, undefined);
    assert.equal(requestOptions.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(requestOptions.body), {
        resourceId: '7033',
        grants_clk: TEST_CLK,
    });
});

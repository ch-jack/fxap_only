'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    deriveClientKey,
    fetchGrantsClk,
    parseEnvText,
    readLocalEnvironment,
    resolveCloudflareConfig,
} = require('../src/cloudflare-grants');

const TEST_TOKEN = 'test-token-with-at-least-thirty-two-characters';
const TEST_CLK = 'ab'.repeat(48);
const TEST_KEY = 'cd'.repeat(32);

test('parses ignored local environment files without mutating process.env', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-cloudflare-env-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, `# local\nCK_GRANTS_CLK_API_TOKEN="${TEST_TOKEN}"\n`);

    assert.equal(readLocalEnvironment(envFile).CK_GRANTS_CLK_API_TOKEN, TEST_TOKEN);
    assert.equal(parseEnvText('A=one\nB=\'two\'\n').B, 'two');
});

test('prefers explicit Cloudflare configuration', () => {
    assert.deepEqual(resolveCloudflareConfig({
        baseUrl: 'https://example.com/',
        environment: {},
        token: TEST_TOKEN,
    }), {
        baseUrl: 'https://example.com',
        token: TEST_TOKEN,
    });
});

test('fetches grants_clk with Bearer authentication', async () => {
    let requestUrl;
    let authorization;
    const result = await fetchGrantsClk('7033', {
        baseUrl: 'https://example.com',
        environment: {},
        fetchImpl: async (url, options) => {
            requestUrl = url;
            authorization = options.headers.authorization;
            return new Response(JSON.stringify({ resourceId: 7033, grants_clk: TEST_CLK }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
        token: TEST_TOKEN,
    });

    assert.equal(result, TEST_CLK);
    assert.equal(requestUrl, 'https://example.com/v1/grants-clk/7033');
    assert.equal(authorization, `Bearer ${TEST_TOKEN}`);
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

test('returns null for a missing Cloudflare KV record', async () => {
    const result = await fetchGrantsClk(9, {
        baseUrl: 'https://example.com',
        environment: {},
        fetchImpl: async () => new Response('{}', { status: 404 }),
        token: TEST_TOKEN,
    });
    assert.equal(result, null);
});

test('requires a configured token without exposing it in errors', async () => {
    await assert.rejects(
        fetchGrantsClk(9, { environment: {}, envFile: 'missing-file', token: '' }),
        /Cloudflare grants token is not configured/,
    );
});

test('rejects malformed grants_clk responses', async () => {
    await assert.rejects(
        fetchGrantsClk(9, {
            baseUrl: 'https://example.com',
            environment: {},
            fetchImpl: async () => new Response(JSON.stringify({
                resourceId: 9,
                grants_clk: 'bad',
            }), { status: 200 }),
            token: TEST_TOKEN,
        }),
        /invalid grants_clk data/,
    );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DEFAULT_API_URL,
    fetchResourceGrants,
    importKeymasterKey,
    resolveGrantsApiConfig,
} = require('../src/grants-api');

const TEST_TOKEN = 'test-public-client-token-with-more-than-32-characters';
const TEST_CFX_KEY = 'cfxk_test_key_for_client_import';
const TEST_GRANT = 'ab'.repeat(32);
const TEST_CLK = 'cd'.repeat(48);

function apiOptions(fetchImpl) {
    return {
        baseUrl: 'http://127.0.0.1:3000/',
        environment: {},
        envFile: 'missing-test-env-file',
        fetchImpl,
        token: TEST_TOKEN,
    };
}
test('uses the HTTPS grants API deployment by default', () => {
    assert.equal(DEFAULT_API_URL, 'https://www.fengshao.icu');
});


test('prefers explicit Keymaster grants API configuration', () => {
    assert.deepEqual(resolveGrantsApiConfig(apiOptions(async () => {})), {
        baseUrl: 'http://127.0.0.1:3000',
        token: TEST_TOKEN,
    });
});

test('imports a validated CFX key with Bearer authentication', async () => {
    let requestUrl;
    let requestOptions;
    const result = await importKeymasterKey(TEST_CFX_KEY, apiOptions(async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return new Response(JSON.stringify({
            requested: 1,
            succeeded: 1,
            failed: 0,
            storedResources: 3,
            overwrittenConflicts: 0,
            items: [],
        }), { status: 200 });
    }));

    assert.equal(result.storedResources, 3);
    assert.equal(requestUrl, 'http://127.0.0.1:3000/v1/keymaster/import');
    assert.equal(requestOptions.method, 'POST');
    assert.equal(requestOptions.headers.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(requestOptions.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(requestOptions.body), { key: TEST_CFX_KEY });
});

test('fetches grants and grants_clk for a resource ID', async () => {
    let requestUrl;
    let requestOptions;
    const result = await fetchResourceGrants('7033', apiOptions(async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return new Response(JSON.stringify({
            resourceId: 7033,
            grants: TEST_GRANT.toUpperCase(),
            grants_clk: TEST_CLK.toUpperCase(),
        }), { status: 200 });
    }));

    assert.deepEqual(result, {
        resourceId: '7033',
        grants: TEST_GRANT,
        grants_clk: TEST_CLK,
    });
    assert.equal(requestUrl, 'http://127.0.0.1:3000/v1/resources/7033');
    assert.equal(requestOptions.method, 'GET');
    assert.equal(requestOptions.headers.authorization, `Bearer ${TEST_TOKEN}`);
});

test('returns null when the grants API has no resource record', async () => {
    const result = await fetchResourceGrants(9, apiOptions(async () => (
        new Response('{}', { status: 404 })
    )));
    assert.equal(result, null);
});

test('reports authentication and rate-limit failures safely', async (context) => {
    await context.test('401', async () => {
        await assert.rejects(
            fetchResourceGrants(9, apiOptions(async () => new Response('{}', { status: 401 }))),
            /rejected the public client token/,
        );
    });
    await context.test('429', async () => {
        await assert.rejects(
            fetchResourceGrants(9, apiOptions(async () => new Response('{}', { status: 429 }))),
            /rate limit exceeded/,
        );
    });
});

test('rejects malformed resource key data', async (context) => {
    await context.test('invalid grants', async () => {
        await assert.rejects(
            fetchResourceGrants(9, apiOptions(async () => new Response(JSON.stringify({
                resourceId: 9,
                grants: 'bad',
                grants_clk: TEST_CLK,
            }), { status: 200 }))),
            /invalid grants data/,
        );
    });
    await context.test('invalid grants_clk', async () => {
        await assert.rejects(
            fetchResourceGrants(9, apiOptions(async () => new Response(JSON.stringify({
                resourceId: 9,
                grants: TEST_GRANT,
                grants_clk: 'bad',
            }), { status: 200 }))),
            /invalid grants_clk data/,
        );
    });
    await context.test('mismatched resource ID', async () => {
        await assert.rejects(
            fetchResourceGrants(9, apiOptions(async () => new Response(JSON.stringify({
                resourceId: 10,
                grants: TEST_GRANT,
                grants_clk: TEST_CLK,
            }), { status: 200 }))),
            /mismatched resource ID/,
        );
    });
});

test('network errors do not expose the Bearer token or CFX key', async () => {
    await assert.rejects(
        importKeymasterKey(TEST_CFX_KEY, apiOptions(async () => {
            throw new Error(`${TEST_TOKEN}:${TEST_CFX_KEY}`);
        })),
        (error) => {
            assert.equal(error.message, 'Could not reach the Keymaster grants API for import');
            assert.equal(error.message.includes(TEST_TOKEN), false);
            assert.equal(error.message.includes(TEST_CFX_KEY), false);
            return true;
        },
    );
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalFirstGrantsLookup } = require('../src/local-grants');

const LOCAL_GRANT = 'ab'.repeat(32);
const LOCAL_CLOCK = 'cd'.repeat(48);
const REMOTE_GRANT = '12'.repeat(32);
const REMOTE_CLOCK = '34'.repeat(48);

function createFixture(context, payload) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-local-grants-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const filePath = path.join(root, 'grants.json');
    fs.writeFileSync(filePath, JSON.stringify(payload));
    return filePath;
}

function silentLogger() {
    return { warn: () => {} };
}

test('returns a complete local grants.json record without calling the API', async (context) => {
    const filePath = createFixture(context, {
        grants: { 7033: LOCAL_GRANT.toUpperCase() },
        grants_clk: { 7033: LOCAL_CLOCK.toUpperCase() },
    });
    let remoteCalls = 0;
    const lookup = createLocalFirstGrantsLookup({
        filePath,
        logger: silentLogger(),
        remoteLookup: async () => {
            remoteCalls += 1;
            return null;
        },
    });

    assert.deepEqual(await lookup(7033), {
        grants: LOCAL_GRANT,
        grants_clk: LOCAL_CLOCK,
        resourceId: '7033',
        source: 'local grants.json',
    });
    assert.equal(remoteCalls, 0);
});

test('falls back to the API when grants.json has no matching record', async (context) => {
    const filePath = createFixture(context, { grants: {}, grants_clk: {} });
    let remoteCalls = 0;
    const lookup = createLocalFirstGrantsLookup({
        filePath,
        logger: silentLogger(),
        remoteLookup: async (resourceId) => {
            remoteCalls += 1;
            return {
                grants: REMOTE_GRANT,
                grants_clk: REMOTE_CLOCK,
                resourceId,
            };
        },
    });

    assert.deepEqual(await lookup('9'), {
        grants: REMOTE_GRANT,
        grants_clk: REMOTE_CLOCK,
        resourceId: '9',
    });
    assert.equal(remoteCalls, 1);
});

test('keeps a local grant and asks the API only for an unsupported grants_clk', async (context) => {
    const filePath = createFixture(context, {
        grants: { 42: LOCAL_GRANT },
        grants_clk: { 42: 'ef'.repeat(64) },
    });
    let remoteCalls = 0;
    const lookup = createLocalFirstGrantsLookup({
        filePath,
        logger: silentLogger(),
        remoteLookup: async (resourceId) => {
            remoteCalls += 1;
            return { grants: null, grants_clk: REMOTE_CLOCK, resourceId };
        },
    });

    assert.deepEqual(await lookup(42), {
        grants: LOCAL_GRANT,
        grants_clk: REMOTE_CLOCK,
        resourceId: '42',
        source: 'local grants.json + Keymaster grants API',
    });
    assert.equal(remoteCalls, 1);
});

test('retains partial local material when the API fallback is unavailable', async (context) => {
    const filePath = createFixture(context, {
        grants: { 88: LOCAL_GRANT },
        grants_clk: {},
    });
    const warnings = [];
    const lookup = createLocalFirstGrantsLookup({
        filePath,
        logger: { warn: (message) => warnings.push(message) },
        remoteLookup: async () => {
            throw new Error('offline');
        },
    });

    assert.deepEqual(await lookup(88), {
        grants: LOCAL_GRANT,
        grants_clk: null,
        resourceId: '88',
        source: 'local grants.json',
    });
    assert.equal(warnings.some((message) => message.includes('offline')), true);
});

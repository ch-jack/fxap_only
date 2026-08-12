'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInitialGrants, parseArguments } = require('../index');

test('accepts a resource folder without a CFX key', () => {
    assert.deepEqual(parseArguments(['D:\\resources']), {
        cfxKey: null,
        folder: 'D:\\resources',
        help: false,
        javaDirectory: null,
        vertexFix: false,
    });
});

test('accepts folder plus Java directory without a CFX key', () => {
    assert.deepEqual(parseArguments(['D:\\resources', 'C:\\Java\\jdk-21']), {
        cfxKey: null,
        folder: 'D:\\resources',
        help: false,
        javaDirectory: 'C:\\Java\\jdk-21',
        vertexFix: false,
    });
});

test('accepts CFX key, resource folder, and optional Java directory', () => {
    assert.deepEqual(parseArguments([
        'cfxk_test',
        'D:\\resources',
        'C:\\Program Files\\Java\\jdk-21',
    ]), {
        cfxKey: 'cfxk_test',
        folder: 'D:\\resources',
        help: false,
        javaDirectory: 'C:\\Program Files\\Java\\jdk-21',
        vertexFix: false,
    });
});

test('preserves the compatibility order folder then CFX key', () => {
    assert.equal(parseArguments(['D:\\resources', 'cfxk_test']).cfxKey, 'cfxk_test');
});

test('accepts vertex repair independently of positional argument order', () => {
    assert.deepEqual(parseArguments([
        'D:\\resources',
        '--vertex-fix',
        'C:\\Java\\jdk-21',
    ]), {
        cfxKey: null,
        folder: 'D:\\resources',
        help: false,
        javaDirectory: 'C:\\Java\\jdk-21',
        vertexFix: true,
    });
});

function silentLogger() {
    return {
        log: () => {},
        warn: () => {},
    };
}

test('uses resource-ID lookup mode when no CFX key is supplied', async () => {
    let officialCalls = 0;
    let importCalls = 0;
    const result = await loadInitialGrants(null, {
        fetchGrants: async () => {
            officialCalls += 1;
        },
        importKeymasterKey: async () => {
            importCalls += 1;
        },
        logger: silentLogger(),
    });

    assert.deepEqual(result, { grants: {}, grants_clk: {} });
    assert.equal(officialCalls, 0);
    assert.equal(importCalls, 0);
});

test('imports a CFX key only after official Keymaster validation succeeds', async () => {
    const calls = [];
    const grants = {
        grants: { 7: 'ab'.repeat(32) },
        grants_clk: { 7: 'cd'.repeat(48) },
    };
    const result = await loadInitialGrants('cfxk_valid', {
        fetchGrants: async (key) => {
            calls.push(['official', key]);
            return grants;
        },
        importKeymasterKey: async (key) => {
            calls.push(['import', key]);
            return { storedResources: 1 };
        },
        logger: silentLogger(),
    });

    assert.equal(result, grants);
    assert.deepEqual(calls, [
        ['official', 'cfxk_valid'],
        ['import', 'cfxk_valid'],
    ]);
});

test('does not import a CFX key when official validation fails', async () => {
    let importCalls = 0;
    const result = await loadInitialGrants('cfxk_rejected', {
        fetchGrants: async () => {
            throw new Error('rejected');
        },
        importKeymasterKey: async () => {
            importCalls += 1;
        },
        logger: silentLogger(),
    });

    assert.deepEqual(result, { grants: {}, grants_clk: {} });
    assert.equal(importCalls, 0);
});

test('keeps official grants when the grants API import fails', async () => {
    const grants = {
        grants: { 9: 'ef'.repeat(32) },
        grants_clk: { 9: '12'.repeat(48) },
    };
    const warnings = [];
    const result = await loadInitialGrants('cfxk_valid', {
        fetchGrants: async () => grants,
        importKeymasterKey: async () => {
            throw new Error('service unavailable');
        },
        logger: {
            log: () => {},
            warn: (message) => warnings.push(message),
        },
    });

    assert.equal(result, grants);
    assert.equal(warnings.some((message) => message.includes('service unavailable')), true);
});

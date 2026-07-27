'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments } = require('../index');

test('accepts a resource folder without a CFX key', () => {
    assert.deepEqual(parseArguments(['D:\\resources']), {
        cfxKey: null,
        folder: 'D:\\resources',
        help: false,
        javaDirectory: null,
    });
});

test('accepts folder plus Java directory without a CFX key', () => {
    assert.deepEqual(parseArguments(['D:\\resources', 'C:\\Java\\jdk-21']), {
        cfxKey: null,
        folder: 'D:\\resources',
        help: false,
        javaDirectory: 'C:\\Java\\jdk-21',
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
    });
});

test('preserves the compatibility order folder then CFX key', () => {
    assert.equal(parseArguments(['D:\\resources', 'cfxk_test']).cfxKey, 'cfxk_test');
});

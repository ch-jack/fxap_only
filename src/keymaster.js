'use strict';

const { KEYMASTER_URL } = require('./constants');

function decodeJwtPayload(token) {
    if (typeof token !== 'string') {
        throw new Error('Keymaster grants token is missing');
    }

    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) {
        throw new Error('Keymaster grants token is malformed');
    }

    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') {
            throw new Error('payload is not an object');
        }
        return payload;
    } catch (_error) {
        throw new Error('Keymaster grants token payload could not be decoded');
    }
}

function validateGrantsPayload(payload) {
    if (!payload
        || typeof payload.grants !== 'object'
        || payload.grants === null
        || typeof payload.grants_clk !== 'object'
        || payload.grants_clk === null) {
        throw new Error('Keymaster grants payload is incomplete');
    }
    return payload;
}

async function fetchGrants(cfxKey, options = {}) {
    if (typeof cfxKey !== 'string' || !cfxKey.startsWith('cfxk_')) {
        throw new Error('CFX key must begin with cfxk_');
    }

    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('Node.js 18 or newer is required (global fetch is unavailable)');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);

    let response;
    try {
        response = await fetchImpl(`${KEYMASTER_URL}/${encodeURIComponent(cfxKey)}`, {
            headers: { 'User-Agent': 'CitizenFX/1' },
            signal: controller.signal,
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new Error('Official Keymaster request timed out');
        }
        throw new Error('Could not reach the official Keymaster service');
    } finally {
        clearTimeout(timeout);
    }

    if (!response || !response.ok) {
        const status = response ? response.status : 'unknown';
        throw new Error(`Official Keymaster returned HTTP ${status}`);
    }

    let body;
    try {
        body = await response.json();
    } catch (_error) {
        throw new Error('Official Keymaster returned invalid JSON');
    }

    if (!body || body.success !== true || !body.grants_token) {
        throw new Error('CFX key was rejected or returned no grants');
    }

    return validateGrantsPayload(decodeJwtPayload(body.grants_token));
}

module.exports = {
    decodeJwtPayload,
    fetchGrants,
    validateGrantsPayload,
};

'use strict';

const path = require('path');
const {
    normalizeResourceId,
    readLocalEnvironment,
} = require('./cloudflare-grants');

const DEFAULT_API_URL = 'https://www.fengshao.icu';
const DEFAULT_API_TOKEN = '3f9879ceccfb1028634e35832d8ee199717d625cac46fec525abd9031b8e03f4';
const DEFAULT_ENV_FILE = path.resolve(__dirname, '..', '.env');

function resolveGrantsApiConfig(options = {}) {
    const environment = options.environment || process.env;
    const localEnvironment = readLocalEnvironment(options.envFile || DEFAULT_ENV_FILE);
    const baseUrl = options.baseUrl
        || environment.CK_KEYMASTER_GRANTS_API_URL
        || localEnvironment.CK_KEYMASTER_GRANTS_API_URL
        || DEFAULT_API_URL;
    const defaultToken = Object.prototype.hasOwnProperty.call(options, 'defaultToken')
        ? options.defaultToken
        : DEFAULT_API_TOKEN;
    const token = options.token
        || environment.CK_KEYMASTER_GRANTS_API_TOKEN
        || localEnvironment.CK_KEYMASTER_GRANTS_API_TOKEN
        || defaultToken;

    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    } catch (_error) {
        throw new Error('Keymaster grants API URL is invalid');
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error('Keymaster grants API URL must use HTTP or HTTPS');
    }
    if (typeof token !== 'string' || token.length < 32) {
        throw new Error('Keymaster grants API token is not configured');
    }

    return {
        baseUrl: parsedUrl.toString().replace(/\/$/, ''),
        token,
    };
}

function normalizeCfxKey(cfxKey) {
    if (typeof cfxKey !== 'string'
        || cfxKey.length > 512
        || !/^cfxk_[A-Za-z0-9_-]+$/.test(cfxKey)) {
        throw new Error('CFX key must begin with cfxk_ and contain only supported characters');
    }
    return cfxKey;
}

function fetchImplementation(options) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('Node.js 18 or newer is required (global fetch is unavailable)');
    }
    return fetchImpl;
}

async function requestWithTimeout(url, requestOptions, options, timeoutMessage, networkMessage) {
    const fetchImpl = fetchImplementation(options);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    try {
        return await fetchImpl(url, {
            ...requestOptions,
            signal: controller.signal,
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new Error(timeoutMessage);
        }
        throw new Error(networkMessage);
    } finally {
        clearTimeout(timeout);
    }
}

async function throwResponseError(response, operation) {
    if (response.status === 401) {
        throw new Error('Keymaster grants API rejected the public client token');
    }
    if (response.status === 429) {
        throw new Error('Keymaster grants API rate limit exceeded; try again later');
    }
    if (response.status === 503) {
        throw new Error('Keymaster grants API is temporarily unavailable');
    }

    let code = '';
    try {
        const body = await response.json();
        if (body && body.error && typeof body.error.code === 'string') {
            code = body.error.code;
        }
    } catch (_error) {
        // Keep the error intentionally free of response bodies and credentials.
    }
    const suffix = code ? ` (${code})` : '';
    throw new Error(`Keymaster grants API ${operation} returned HTTP ${response.status}${suffix}`);
}

async function importKeymasterKey(cfxKey, options = {}) {
    const key = normalizeCfxKey(cfxKey);
    const { baseUrl, token } = resolveGrantsApiConfig(options);
    const response = await requestWithTimeout(
        `${baseUrl}/v1/keymaster/import`,
        {
            body: JSON.stringify({ key }),
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'user-agent': 'FXAP-Only/1',
            },
            method: 'POST',
        },
        options,
        'Keymaster grants API import timed out',
        'Could not reach the Keymaster grants API for import',
    );
    if (!response.ok) {
        await throwResponseError(response, 'import');
    }

    let body;
    try {
        body = await response.json();
    } catch (_error) {
        throw new Error('Keymaster grants API import returned invalid JSON');
    }
    if (!body
        || body.requested !== 1
        || body.succeeded !== 1
        || body.failed !== 0
        || !Number.isInteger(body.storedResources)
        || body.storedResources < 0) {
        throw new Error('Keymaster grants API import returned an invalid result');
    }
    return body;
}

function normalizeNullableHex(value, length, name) {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value)) {
        throw new Error(`Keymaster grants API returned invalid ${name} data`);
    }
    return value.toLowerCase();
}

async function fetchResourceGrants(resourceId, options = {}) {
    const normalizedResourceId = normalizeResourceId(resourceId);
    const { baseUrl, token } = resolveGrantsApiConfig(options);
    const response = await requestWithTimeout(
        `${baseUrl}/v1/resources/${normalizedResourceId}`,
        {
            headers: {
                authorization: `Bearer ${token}`,
                'user-agent': 'FXAP-Only/1',
            },
            method: 'GET',
        },
        options,
        'Keymaster grants API lookup timed out',
        'Could not reach the Keymaster grants API for resource lookup',
    );
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        await throwResponseError(response, 'lookup');
    }

    let body;
    try {
        body = await response.json();
    } catch (_error) {
        throw new Error('Keymaster grants API lookup returned invalid JSON');
    }
    if (!body || String(body.resourceId) !== normalizedResourceId) {
        throw new Error('Keymaster grants API returned a mismatched resource ID');
    }
    return {
        grants: normalizeNullableHex(body.grants, 64, 'grants'),
        grants_clk: normalizeNullableHex(body.grants_clk, 96, 'grants_clk'),
        resourceId: normalizedResourceId,
    };
}

module.exports = {
    DEFAULT_API_URL,
    fetchResourceGrants,
    importKeymasterKey,
    normalizeCfxKey,
    resolveGrantsApiConfig,
};

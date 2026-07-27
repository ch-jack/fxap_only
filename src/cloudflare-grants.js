'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_API_URL = 'https://grantsclk.ckcloud.de5.net';
const DEFAULT_ENV_FILE = path.resolve(__dirname, '..', '.env');

function parseEnvText(text) {
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) {
            continue;
        }
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

function readLocalEnvironment(filePath = DEFAULT_ENV_FILE) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    return parseEnvText(fs.readFileSync(filePath, 'utf8'));
}

function resolveCloudflareConfig(options = {}) {
    const environment = options.environment || process.env;
    const localEnvironment = readLocalEnvironment(options.envFile || DEFAULT_ENV_FILE);
    const baseUrl = options.baseUrl
        || environment.CK_GRANTS_CLK_API_URL
        || localEnvironment.CK_GRANTS_CLK_API_URL
        || DEFAULT_API_URL;
    const token = options.token
        || environment.CK_GRANTS_CLK_API_TOKEN
        || environment.GRANTS_CLK_API_TOKEN
        || localEnvironment.CK_GRANTS_CLK_API_TOKEN
        || localEnvironment.GRANTS_CLK_API_TOKEN
        || '';

    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    } catch (_error) {
        throw new Error('Cloudflare grants API URL is invalid');
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        throw new Error('Cloudflare grants API URL must use HTTP or HTTPS');
    }

    return {
        baseUrl: parsedUrl.toString().replace(/\/$/, ''),
        token,
    };
}

function normalizeResourceId(resourceId) {
    const text = String(resourceId);
    if (!/^[0-9]+$/.test(text)) {
        throw new Error('resourceId must be an unsigned decimal integer');
    }
    const value = BigInt(text);
    if (value > 0xffffffffn) {
        throw new Error('resourceId must be between 0 and 4294967295');
    }
    return value.toString(10);
}

function normalizeGrantsClk(grantsClk) {
    const value = Buffer.isBuffer(grantsClk)
        ? grantsClk.toString('hex')
        : String(grantsClk || '');
    if (!/^[0-9a-f]{96}$/i.test(value)) {
        throw new Error('grants_clk must be exactly 48 bytes');
    }
    return value.toLowerCase();
}

async function fetchGrantsClk(resourceId, options = {}) {
    const normalizedResourceId = normalizeResourceId(resourceId);
    const { baseUrl, token } = resolveCloudflareConfig(options);
    if (typeof token !== 'string' || token.length < 32) {
        throw new Error(
            'Cloudflare grants token is not configured; set CK_GRANTS_CLK_API_TOKEN or create .env',
        );
    }

    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('Node.js 18 or newer is required (global fetch is unavailable)');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    let response;
    try {
        response = await fetchImpl(`${baseUrl}/v1/grants-clk/${normalizedResourceId}`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new Error('Cloudflare grants lookup timed out');
        }
        throw new Error('Could not reach the Cloudflare grants service');
    } finally {
        clearTimeout(timeout);
    }

    if (response.status === 404) {
        return null;
    }
    if (response.status === 401) {
        throw new Error('Cloudflare grants service rejected the Bearer token');
    }
    if (response.status === 429) {
        throw new Error('Cloudflare grants service rate limit exceeded; try again later');
    }
    if (!response.ok) {
        throw new Error(`Cloudflare grants service returned HTTP ${response.status}`);
    }

    let body;
    try {
        body = await response.json();
    } catch (_error) {
        throw new Error('Cloudflare grants service returned invalid JSON');
    }
    if (!body
        || String(body.resourceId) !== normalizedResourceId
        || typeof body.grants_clk !== 'string'
        || !/^[0-9a-f]{96}$/i.test(body.grants_clk)) {
        throw new Error('Cloudflare grants service returned invalid grants_clk data');
    }
    return body.grants_clk.toLowerCase();
}

async function deriveClientKey(resourceId, grantsClk, options = {}) {
    const normalizedResourceId = normalizeResourceId(resourceId);
    const normalizedGrantsClk = normalizeGrantsClk(grantsClk);
    const { baseUrl } = resolveCloudflareConfig(options);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('Node.js 18 or newer is required (global fetch is unavailable)');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
    let response;
    try {
        response = await fetchImpl(`${baseUrl}/v1/derive`, {
            body: JSON.stringify({
                resourceId: normalizedResourceId,
                grants_clk: normalizedGrantsClk,
            }),
            headers: {
                'content-type': 'application/json',
                'user-agent': 'FXAP-Only/1',
            },
            method: 'POST',
            signal: controller.signal,
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new Error('Cloudflare client-key derivation timed out');
        }
        throw new Error('Could not reach the Cloudflare key derivation service');
    } finally {
        clearTimeout(timeout);
    }

    if (response.status === 429) {
        throw new Error('Cloudflare grants service rate limit exceeded; try again later');
    }
    if (!response.ok) {
        throw new Error(`Cloudflare key derivation service returned HTTP ${response.status}`);
    }

    let body;
    try {
        body = await response.json();
    } catch (_error) {
        throw new Error('Cloudflare key derivation service returned invalid JSON');
    }
    if (!body
        || String(body.resourceId) !== normalizedResourceId
        || typeof body.key !== 'string'
        || !/^[0-9a-f]{64}$/i.test(body.key)) {
        throw new Error('Cloudflare key derivation service returned invalid key data');
    }
    return body.key.toLowerCase();
}

module.exports = {
    DEFAULT_API_URL,
    deriveClientKey,
    fetchGrantsClk,
    normalizeGrantsClk,
    normalizeResourceId,
    parseEnvText,
    readLocalEnvironment,
    resolveCloudflareConfig,
};

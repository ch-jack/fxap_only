'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeResourceId } = require('./cloudflare-grants');

const DEFAULT_LOCAL_GRANTS_FILE = path.resolve(__dirname, '..', 'grants.json');

function normalizeLocalHex(value, length) {
    if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value)) {
        return null;
    }
    return value.toLowerCase();
}

function createLocalFirstGrantsLookup(options = {}) {
    const filePath = path.resolve(options.filePath || DEFAULT_LOCAL_GRANTS_FILE);
    const remoteLookup = options.remoteLookup;
    const logger = options.logger || console;
    let loadAttempted = false;
    let localPayload = null;

    const logWarning = (message) => {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(message);
        }
    };

    const loadLocalPayload = () => {
        if (loadAttempted) {
            return localPayload;
        }
        loadAttempted = true;

        if (!fs.existsSync(filePath)) {
            logWarning(`Local grants file was not found; using the grants API: ${filePath}`);
            return null;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!parsed
                || typeof parsed !== 'object'
                || Array.isArray(parsed)
                || !parsed.grants
                || typeof parsed.grants !== 'object'
                || Array.isArray(parsed.grants)
                || !parsed.grants_clk
                || typeof parsed.grants_clk !== 'object'
                || Array.isArray(parsed.grants_clk)) {
                throw new Error('expected grants and grants_clk objects');
            }
            localPayload = parsed;
            return localPayload;
        } catch (error) {
            logWarning(`Local grants file could not be read; using the grants API: ${error.message}`);
            return null;
        }
    };

    return async (resourceId) => {
        const normalizedResourceId = normalizeResourceId(resourceId);
        const payload = loadLocalPayload();
        const local = {
            grants: normalizeLocalHex(payload?.grants?.[normalizedResourceId], 64),
            grants_clk: normalizeLocalHex(payload?.grants_clk?.[normalizedResourceId], 96),
            resourceId: normalizedResourceId,
            source: 'local grants.json',
        };
        const hasLocalGrant = !!local.grants;
        const hasLocalClock = !!local.grants_clk;

        if (hasLocalGrant && hasLocalClock) {
            return local;
        }
        if (typeof remoteLookup !== 'function') {
            return hasLocalGrant || hasLocalClock ? local : null;
        }

        let remote;
        try {
            remote = await remoteLookup(normalizedResourceId);
        } catch (error) {
            if (!hasLocalGrant && !hasLocalClock) {
                throw error;
            }
            logWarning(
                `Local grants.json supplied partial key material for ${normalizedResourceId}; `
                + `grants API fallback warning: ${error.message}`,
            );
            return local;
        }

        if (!remote) {
            return hasLocalGrant || hasLocalClock ? local : null;
        }

        const merged = {
            grants: local.grants || remote.grants || null,
            grants_clk: local.grants_clk || remote.grants_clk || null,
            resourceId: normalizedResourceId,
        };
        const remoteAddedMaterial = (!hasLocalGrant && !!remote.grants)
            || (!hasLocalClock && !!remote.grants_clk);
        if (hasLocalGrant || hasLocalClock) {
            merged.source = remoteAddedMaterial
                ? 'local grants.json + Keymaster grants API'
                : 'local grants.json';
        }
        return merged;
    };
}

module.exports = {
    DEFAULT_LOCAL_GRANTS_FILE,
    createLocalFirstGrantsLookup,
    normalizeLocalHex,
};

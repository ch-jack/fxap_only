'use strict';

const crypto = require('crypto');
const {
    CLIENT_AES_KEYS,
    DEFAULT_KEY,
    FXAP_HEADER,
    LUA_HEADER,
    RSC7_HEADER,
    RSC8_HEADER,
} = require('./constants');

function chacha20(key, nonce, input) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new Error('ChaCha20 key must be 32 bytes');
    }
    if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
        throw new Error('ChaCha20 nonce must be 12 bytes');
    }

    // Node/OpenSSL expects a 32-bit little-endian counter followed by the
    // 96-bit nonce. The original chacha20 package starts with counter zero.
    const iv = Buffer.alloc(16);
    nonce.copy(iv, 4);
    const cipher = crypto.createDecipheriv('chacha20', key, iv);
    return Buffer.concat([cipher.update(input), cipher.final()]);
}

function isFxap(buffer) {
    return Buffer.isBuffer(buffer)
        && buffer.length >= 4
        && buffer.subarray(0, 4).equals(FXAP_HEADER);
}

function isLuaBytecode(buffer) {
    return Buffer.isBuffer(buffer)
        && buffer.length >= LUA_HEADER.length
        && buffer.subarray(0, LUA_HEADER.length).equals(LUA_HEADER);
}

function isRsc(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return false;
    }
    const header = buffer.subarray(0, 4);
    return header.equals(RSC7_HEADER) || header.equals(RSC8_HEADER);
}

function decryptOuterBuffer(buffer, key = DEFAULT_KEY) {
    if (!isFxap(buffer) || buffer.length <= 86) {
        return null;
    }

    try {
        return chacha20(key, buffer.subarray(74, 86), buffer.subarray(86));
    } catch (_error) {
        return null;
    }
}

function decryptAt(buffer, key, payloadOffset, ivOffset) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(key)) {
        return null;
    }
    if (!Number.isInteger(payloadOffset) || !Number.isInteger(ivOffset)) {
        return null;
    }
    if (ivOffset < 0 || payloadOffset <= ivOffset || ivOffset + 12 > payloadOffset) {
        return null;
    }
    if (payloadOffset >= buffer.length) {
        return null;
    }

    try {
        return chacha20(
            key,
            buffer.subarray(ivOffset, ivOffset + 12),
            buffer.subarray(payloadOffset),
        );
    } catch (_error) {
        return null;
    }
}

function decryptInnerBuffer(buffer, key, payloadOffset = null, ivOffset = null) {
    if (!Buffer.isBuffer(buffer) || !Buffer.isBuffer(key)) {
        return null;
    }

    if (payloadOffset !== null || ivOffset !== null) {
        return decryptAt(buffer, key, payloadOffset, ivOffset);
    }

    if (buffer.length >= 18) {
        try {
            const nameLength = buffer.readUInt16LE(4);
            const derivedIvOffset = 6 + nameLength;
            const derivedPayloadOffset = derivedIvOffset + 12;
            const dynamicResult = decryptAt(
                buffer,
                key,
                derivedPayloadOffset,
                derivedIvOffset,
            );
            if (dynamicResult) {
                return dynamicResult;
            }
        } catch (_error) {
            // Fall through to the legacy fixed offsets.
        }
    }

    return decryptAt(buffer, key, 92, 80);
}

function scanResourceId(fxapPayload) {
    if (!Buffer.isBuffer(fxapPayload) || fxapPayload.length < 78) {
        return null;
    }

    const resourceId = fxapPayload.readUInt32BE(74);
    return resourceId > 0 ? String(resourceId) : null;
}

function deriveClientKeyWithAes(grantsClk, aesKey) {
    if (!Buffer.isBuffer(grantsClk) || grantsClk.length < 32) {
        return null;
    }
    if (!Buffer.isBuffer(aesKey) || aesKey.length !== 32) {
        return null;
    }

    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-cbc',
            aesKey,
            grantsClk.subarray(0, 16),
        );
        decipher.setAutoPadding(false);
        let result = Buffer.concat([
            decipher.update(grantsClk.subarray(16)),
            decipher.final(),
        ]);

        const paddingLength = result[result.length - 1];
        if (paddingLength > 0 && paddingLength <= 16) {
            result = result.subarray(0, result.length - paddingLength);
        }
        return result;
    } catch (_error) {
        return null;
    }
}

function uniqueBuffers(buffers) {
    const seen = new Set();
    const result = [];
    for (const buffer of buffers) {
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
            continue;
        }
        const hex = buffer.toString('hex');
        if (!seen.has(hex)) {
            seen.add(hex);
            result.push(buffer);
        }
    }
    return result;
}

function buildLegacyClientKeyCandidates(grantsClk) {
    if (!Buffer.isBuffer(grantsClk) || grantsClk.length < 16) {
        return [];
    }

    return uniqueBuffers([
        ...CLIENT_AES_KEYS.map((key) => deriveClientKeyWithAes(grantsClk, key)),
        grantsClk.length >= 48 ? grantsClk.subarray(16, 48) : null,
    ]);
}

function parseHexKey(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0) {
        throw new Error(`${label} is not valid hex data`);
    }
    if (!/^[0-9a-f]+$/i.test(value)) {
        throw new Error(`${label} is not valid hex data`);
    }
    return Buffer.from(value, 'hex');
}

module.exports = {
    buildLegacyClientKeyCandidates,
    chacha20,
    decryptAt,
    decryptInnerBuffer,
    decryptOuterBuffer,
    deriveClientKeyWithAes,
    isFxap,
    isLuaBytecode,
    isRsc,
    parseHexKey,
    scanResourceId,
    uniqueBuffers,
};

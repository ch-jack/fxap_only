'use strict';

const fs = require('fs');
const path = require('path');
const { FILE_CONCURRENCY } = require('./constants');
const {
    decryptAt,
    decryptInnerBuffer,
    decryptOuterBuffer,
    isFxap,
    isLuaBytecode,
    isRsc,
    parseHexKey,
    scanResourceId,
    uniqueBuffers,
} = require('./crypto');
const { JavaDecompiler } = require('./java-decompiler');

const STREAM_EXTENSIONS = new Set([
    '.awc',
    '.ybn',
    '.ydd',
    '.ydr',
    '.yft',
    '.ymap',
    '.ymf',
    '.ytd',
    '.ytyp',
]);

function getAllFiles(root) {
    const files = [];
    const pending = [path.resolve(root)];

    while (pending.length > 0) {
        const current = pending.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(fullPath);
            } else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

function isStreamFile(fileName) {
    return STREAM_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function validateDecryption(buffer) {
    return isLuaBytecode(buffer) || isRsc(buffer);
}

function createStats(totalFiles) {
    return {
        copied: 0,
        decrypted: 0,
        encrypted: 0,
        failed: 0,
        luaDecompiled: 0,
        luaFallback: 0,
        resourceId: null,
        totalFiles,
    };
}

class FxapDecryptor {
    constructor(options) {
        this.outputDir = path.resolve(options.outputDir);
        this.tempDir = path.resolve(options.tempDir);
        this.fileConcurrency = Math.max(1, Number(options.fileConcurrency || FILE_CONCURRENCY));
        this.log = typeof options.log === 'function' ? options.log : console.log;
        this.decompiler = options.decompiler || new JavaDecompiler(this.tempDir, {
            javaDirectory: options.javaDirectory,
        });
        this.grantsLookup = typeof options.grantsLookup === 'function'
            ? options.grantsLookup
            : null;
        this.clientKeyDeriver = typeof options.clientKeyDeriver === 'function'
            ? options.clientKeyDeriver
            : null;
    }

    async processWithConcurrency(items, worker) {
        const results = new Array(items.length);
        let nextIndex = 0;
        const workerCount = Math.min(this.fileConcurrency, Math.max(1, items.length));
        const runners = Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = nextIndex;
                nextIndex += 1;
                if (index >= items.length) {
                    return;
                }
                results[index] = await worker(items[index], index);
                if ((index + 1) % 8 === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
            }
        });
        await Promise.all(runners);
        return results;
    }

    readKeyEntry(grantsPayload, resourceId) {
        const grantHex = grantsPayload.grants[resourceId];
        const clockHex = grantsPayload.grants_clk[resourceId];
        let grantsClk = null;
        if (clockHex) {
            grantsClk = parseHexKey(clockHex, `grants_clk for resource ${resourceId}`);
            if (grantsClk.length !== 48) {
                throw new Error(`grants_clk for resource ${resourceId} is not 48 bytes`);
            }
        }

        let directKey = null;
        if (grantHex) {
            directKey = parseHexKey(grantHex, `grant for resource ${resourceId}`);
            if (directKey.length !== 32) {
                throw new Error(`Grant for resource ${resourceId} is not a 32-byte key`);
            }
        }

        const keys = uniqueBuffers([directKey]);
        if (keys.length === 0 && !grantsClk) {
            return null;
        }
        return {
            alternativeKeys: keys.slice(1),
            cloudDerivationAttempted: false,
            cloudDerivationError: null,
            decryptKey: keys[0] || null,
            grantsClk,
            hasDirectGrant: !!directKey,
            resourceId,
        };
    }

    async attachCloudClientKey(entry) {
        if (entry.cloudDerivationAttempted || !entry.grantsClk || !this.clientKeyDeriver) {
            return entry;
        }
        entry.cloudDerivationAttempted = true;
        this.log(`  Requesting client key from Cloudflare for ${entry.resourceId}`);

        try {
            const value = await this.clientKeyDeriver(
                entry.resourceId,
                entry.grantsClk.toString('hex'),
            );
            const cloudKey = Buffer.isBuffer(value)
                ? Buffer.from(value)
                : parseHexKey(value, `Cloudflare client key for resource ${entry.resourceId}`);
            if (cloudKey.length !== 32) {
                throw new Error(
                    `Cloudflare client key for resource ${entry.resourceId} is not 32 bytes`,
                );
            }

            const keys = uniqueBuffers([
                entry.hasDirectGrant ? entry.decryptKey : null,
                cloudKey,
                entry.decryptKey,
                ...entry.alternativeKeys,
            ]);
            entry.decryptKey = keys[0] || null;
            entry.alternativeKeys = keys.slice(1);
            this.log('  Client key source: Cloudflare /v1/derive');
        } catch (error) {
            entry.cloudDerivationError = error;
            this.log(`  Cloudflare client-key warning: ${error.message}`);
        }
        return entry;
    }

    findEncryptedSample(resourcePath, relativeFiles) {
        for (const relativePath of relativeFiles) {
            if (path.basename(relativePath).toLowerCase() === '.fxap') {
                continue;
            }
            const buffer = fs.readFileSync(path.join(resourcePath, relativePath));
            if (isFxap(buffer)) {
                return decryptOuterBuffer(buffer);
            }
        }
        return null;
    }

    async resolveKeys(resourcePath, relativeFiles, grantsPayload, expectedResourceId) {
        const availableIds = new Set([
            ...Object.keys(grantsPayload.grants),
            ...Object.keys(grantsPayload.grants_clk),
        ]);
        availableIds.delete(expectedResourceId);
        const candidateIds = [expectedResourceId, ...availableIds];
        const entries = [];
        for (const resourceId of candidateIds) {
            try {
                const entry = this.readKeyEntry(grantsPayload, resourceId);
                if (entry) {
                    entries.push(entry);
                }
            } catch (error) {
                if (resourceId === expectedResourceId) {
                    throw error;
                }
            }
        }

        if (entries.length === 0) {
            throw new Error(
                `No usable grants or grants_clk were found for resource ID ${expectedResourceId}`,
            );
        }

        const sample = this.findEncryptedSample(resourcePath, relativeFiles);
        const entryMatchesSample = (entry) => {
            if (!sample) {
                return false;
            }
            const keys = uniqueBuffers([entry.decryptKey, ...entry.alternativeKeys]);
            return keys.some((key) => validateDecryption(decryptInnerBuffer(sample, key)));
        };
        const reportResourceMatch = (entry) => {
            if (entry.resourceId !== expectedResourceId) {
                this.log(
                    `  Resource ID matched grant ${entry.resourceId} instead of ${expectedResourceId}`,
                );
            }
        };

        if (sample) {
            for (const entry of entries) {
                if (entryMatchesSample(entry)) {
                    await this.attachCloudClientKey(entry);
                    reportResourceMatch(entry);
                    return entry;
                }
            }

            for (const entry of entries) {
                await this.attachCloudClientKey(entry);
                if (entryMatchesSample(entry)) {
                    reportResourceMatch(entry);
                    return entry;
                }
            }
        }

        const expected = entries.find((entry) => entry.resourceId === expectedResourceId);
        if (expected) {
            await this.attachCloudClientKey(expected);
            if (!expected.decryptKey && expected.alternativeKeys.length === 0) {
                const detail = expected.cloudDerivationError
                    ? `: ${expected.cloudDerivationError.message}`
                    : '';
                throw new Error(
                    `No usable key was obtained for resource ID ${expectedResourceId}${detail}`,
                );
            }
            return expected;
        }
        throw new Error(`No matching key material was found for resource ID ${expectedResourceId}`);
    }

    findFilenameEnd(buffer) {
        const extensions = [...STREAM_EXTENSIONS];
        for (let index = 0; index < buffer.length - 20; index += 1) {
            const text = buffer.subarray(index, index + 20).toString('utf8');
            for (const extension of extensions) {
                const extensionIndex = text.indexOf(extension);
                if (extensionIndex !== -1) {
                    return index + extensionIndex + extension.length;
                }
            }
        }
        return -1;
    }

    decryptStreamBuffer(encryptedData, key) {
        if (!Buffer.isBuffer(encryptedData) || encryptedData.length < 100 || !key) {
            return null;
        }

        const filenameEnd = this.findFilenameEnd(encryptedData);
        if (filenameEnd > 0) {
            for (const ivOffset of [
                filenameEnd,
                filenameEnd + 1,
                filenameEnd + 2,
                filenameEnd + 4,
                filenameEnd + 8,
            ]) {
                const result = decryptAt(encryptedData, key, ivOffset + 12, ivOffset);
                if (isRsc(result)) {
                    return result;
                }
            }
        }

        for (let ivOffset = 40; ivOffset <= 120; ivOffset += 1) {
            const result = decryptAt(encryptedData, key, ivOffset + 12, ivOffset);
            if (isRsc(result)) {
                return result;
            }
        }
        return null;
    }

    async findLuaBytecode(encryptedData, keys) {
        for (const key of keys) {
            const standard = decryptInnerBuffer(encryptedData, key);
            if (isLuaBytecode(standard)) {
                return standard;
            }

            const legacy = decryptAt(encryptedData, key, 90, 78);
            if (isLuaBytecode(legacy)) {
                return legacy;
            }
        }

        for (const key of keys) {
            for (let payloadOffset = 50; payloadOffset <= 150; payloadOffset += 1) {
                if (payloadOffset % 5 === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                for (let ivOffset = 38; ivOffset <= 138; ivOffset += 1) {
                    if (ivOffset + 12 > payloadOffset) {
                        continue;
                    }
                    const candidate = decryptAt(encryptedData, key, payloadOffset, ivOffset);
                    if (isLuaBytecode(candidate)) {
                        return candidate;
                    }
                }
            }
        }
        return null;
    }

    findStreamPayload(encryptedData, keys) {
        for (const key of keys) {
            const standard = decryptInnerBuffer(encryptedData, key);
            if (isRsc(standard)) {
                return standard;
            }
            const scanned = this.decryptStreamBuffer(encryptedData, key);
            if (scanned) {
                return scanned;
            }
        }
        return null;
    }

    writeFailure(outputPath, message) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(`${outputPath}.failed.txt`, `${message}\n`, 'utf8');
    }

    async decryptFile(resourcePath, relativePath, keyEntry, stats) {
        const inputPath = path.join(resourcePath, relativePath);
        const outputPath = path.join(this.outputDir, relativePath);
        const input = fs.readFileSync(inputPath);

        if (!isFxap(input)) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.copyFileSync(inputPath, outputPath);
            stats.copied += 1;
            return;
        }

        stats.encrypted += 1;
        const encryptedData = decryptOuterBuffer(input);
        if (!encryptedData) {
            stats.failed += 1;
            this.writeFailure(outputPath, 'Failed to decrypt the outer FXAP layer');
            return;
        }

        const keys = uniqueBuffers([keyEntry.decryptKey, ...keyEntry.alternativeKeys]);
        const lowerName = relativePath.toLowerCase();

        if (lowerName.endsWith('.lua')) {
            const bytecode = await this.findLuaBytecode(encryptedData, keys);
            if (!bytecode) {
                stats.failed += 1;
                this.writeFailure(outputPath, 'Failed to recover Lua bytecode');
                return;
            }

            const result = await this.decompiler.decompile(bytecode, outputPath, relativePath);
            stats.decrypted += 1;
            if (result.success) {
                stats.luaDecompiled += 1;
            } else {
                stats.luaFallback += 1;
                this.log(`  Lua fallback: ${relativePath} (${result.reason})`);
            }
            return;
        }

        if (isStreamFile(relativePath)) {
            const stream = this.findStreamPayload(encryptedData, keys);
            if (!stream) {
                stats.failed += 1;
                this.writeFailure(outputPath, 'Failed to recover an RSC stream payload');
                return;
            }
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, stream);
            stats.decrypted += 1;
            return;
        }

        let decrypted = null;
        for (const key of keys) {
            decrypted = decryptInnerBuffer(encryptedData, key);
            if (decrypted) {
                break;
            }
        }
        if (!decrypted) {
            stats.failed += 1;
            this.writeFailure(outputPath, 'Failed to decrypt the resource file');
            return;
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, decrypted);
        stats.decrypted += 1;
    }

    async decryptResource(resourcePath, grantsPayload) {
        const resolvedResourcePath = path.resolve(resourcePath);
        const fxapPath = path.join(resolvedResourcePath, '.fxap');
        if (!fs.existsSync(fxapPath)) {
            throw new Error(`Missing .fxap: ${fxapPath}`);
        }

        const fxapPayload = decryptOuterBuffer(fs.readFileSync(fxapPath));
        const resourceId = scanResourceId(fxapPayload);
        if (!resourceId) {
            throw new Error(`Could not read a resource ID from ${fxapPath}`);
        }

        const allFiles = getAllFiles(resolvedResourcePath);
        const relativeFiles = allFiles
            .map((filePath) => path.relative(resolvedResourcePath, filePath))
            .filter((relativePath) => path.basename(relativePath).toLowerCase() !== '.fxap');
        const stats = createStats(relativeFiles.length);
        stats.resourceId = resourceId;
        this.log(`  Resource ID: ${resourceId}`);

        const effectiveGrants = {
            grants: { ...(grantsPayload?.grants || {}) },
            grants_clk: { ...(grantsPayload?.grants_clk || {}) },
        };
        const needsLookup = !effectiveGrants.grants[resourceId]
            || !effectiveGrants.grants_clk[resourceId];
        if (needsLookup && this.grantsLookup) {
            this.log(`  Key material incomplete in the initial payload; checking configured grants sources for ${resourceId}`);
            try {
                const remoteGrants = await this.grantsLookup(resourceId);
                if (remoteGrants) {
                    const importedFields = [];
                    for (const field of ['grants', 'grants_clk']) {
                        if (!effectiveGrants[field][resourceId] && remoteGrants[field]) {
                            effectiveGrants[field][resourceId] = remoteGrants[field];
                            importedFields.push(field);

                            if (grantsPayload && typeof grantsPayload === 'object') {
                                if (!grantsPayload[field]
                                    || typeof grantsPayload[field] !== 'object') {
                                    grantsPayload[field] = {};
                                }
                                grantsPayload[field][resourceId] = remoteGrants[field];
                            }
                        }
                    }
                    if (importedFields.length > 0) {
                        const keyMaterialSource = typeof remoteGrants.source === 'string'
                            ? remoteGrants.source
                            : 'Keymaster grants API';
                        this.log(
                            `  Key material source: ${keyMaterialSource} (${importedFields.join(', ')})`,
                        );
                    } else {
                        this.log('  Keymaster grants API returned no additional key material');
                    }
                } else {
                    this.log(`  No grants API record was found for ${resourceId}`);
                }
            } catch (error) {
                const hasLocalKeyMaterial = Object.keys(effectiveGrants.grants).length > 0
                    || Object.keys(effectiveGrants.grants_clk).length > 0;
                if (!hasLocalKeyMaterial) {
                    throw new Error(
                        `Keymaster grants API lookup failed for resource ${resourceId}: ${error.message}`,
                    );
                }
                this.log(`  Keymaster grants API lookup warning: ${error.message}`);
            }
        }

        const keyEntry = await this.resolveKeys(
            resolvedResourcePath,
            relativeFiles,
            effectiveGrants,
            resourceId,
        );
        fs.mkdirSync(this.outputDir, { recursive: true });
        fs.mkdirSync(this.tempDir, { recursive: true });

        await this.processWithConcurrency(relativeFiles, async (relativePath) => {
            try {
                await this.decryptFile(resolvedResourcePath, relativePath, keyEntry, stats);
            } catch (error) {
                stats.failed += 1;
                const outputPath = path.join(this.outputDir, relativePath);
                this.writeFailure(outputPath, `Unexpected error: ${error.message}`);
            }
        });

        return stats;
    }
}

module.exports = {
    FxapDecryptor,
    STREAM_EXTENSIONS,
    getAllFiles,
    isStreamFile,
    validateDecryption,
};

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { deriveClientKey } = require('./src/cloudflare-grants');
const { fetchResourceGrants, importKeymasterKey } = require('./src/grants-api');
const { FxapDecryptor } = require('./src/decryptor');
const {
    defaultOutputRoot,
    discoverResourceFolders,
    outputForResource,
} = require('./src/discover');
const { resolveJava } = require('./src/java-decompiler');
const { fetchGrants } = require('./src/keymaster');
const { createLocalFirstGrantsLookup } = require('./src/local-grants');
const { repairDecryptedResources } = require('./src/vertex-fixer');

function printUsage() {
    console.log(`
FXAP Decryptor

Usage:
  node . [--vertex-fix] <folder> [java-folder]
  node . [--vertex-fix] <cfx-key> <folder> [java-folder]

Examples:
  node . "D:\\server\\resources\\my_resource"
  node . "D:\\server\\resources" "C:\\Program Files\\Java\\jdk-21"
  node . "cfxk_xxxxxxxxx" "D:\\server\\resources" "C:\\Program Files\\Java\\jdk-21"

The CFX key is optional. Client keys are requested from Cloudflare /v1/derive.
After a CFX key passes official Keymaster validation, its grants are imported
into the Keymaster grants API. Without a key, grants and grants_clk are queried
by resource ID. The client-key derivation formula is not included here.

--vertex-fix creates a complete sibling copy after decryption and repairs only
.ydr/.yft/.ydd files inside that copy. The decrypted output is never overwritten.
`);
}

function parseArguments(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return { help: true };
    }
    const positional = [];
    let vertexFix = false;
    for (const argument of argv) {
        if (argument === '--vertex-fix') {
            vertexFix = true;
        } else if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        } else {
            positional.push(argument);
        }
    }
    if (positional.length < 1 || positional.length > 3) {
        throw new Error('Required argument: folder; optional arguments: CFX key and Java folder');
    }

    if (positional.length === 1) {
        return {
            cfxKey: null,
            folder: positional[0],
            help: false,
            javaDirectory: null,
            vertexFix,
        };
    }

    const [first, second, third] = positional;
    if (first.startsWith('cfxk_')) {
        return {
            cfxKey: first,
            folder: second,
            help: false,
            javaDirectory: third || null,
            vertexFix,
        };
    }
    if (second.startsWith('cfxk_')) {
        return {
            cfxKey: second,
            folder: first,
            help: false,
            javaDirectory: third || null,
            vertexFix,
        };
    }
    if (positional.length === 2) {
        return {
            cfxKey: null,
            folder: first,
            help: false,
            javaDirectory: second,
            vertexFix,
        };
    }
    throw new Error('Three arguments require a CFX key in the first or second position');
}

function safeRemoveTemp(tempPath) {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(tempPath);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to remove path outside the temporary folder: ${resolved}`);
    }
    fs.rmSync(resolved, { force: true, recursive: true });
}

function formatStats(stats) {
    return [
        `files=${stats.totalFiles}`,
        `decrypted=${stats.decrypted}`,
        `copied=${stats.copied}`,
        `lua=${stats.luaDecompiled}`,
        `lua-fallback=${stats.luaFallback}`,
        `failed=${stats.failed}`,
    ].join(' ');
}

async function loadInitialGrants(cfxKey, dependencies = {}) {
    const requestOfficial = dependencies.fetchGrants || fetchGrants;
    const importValidatedKey = dependencies.importKeymasterKey || importKeymasterKey;
    const logger = dependencies.logger || console;
    const empty = { grants: {}, grants_clk: {} };

    if (!cfxKey) {
        logger.log('No CFX key supplied; checking local grants.json before the grants API.');
        return empty;
    }

    logger.log('Requesting grants from the official Cfx.re Keymaster...');
    let grantsPayload;
    try {
        grantsPayload = await requestOfficial(cfxKey);
    } catch (error) {
        logger.warn(`Keymaster warning: ${error.message}`);
        logger.warn('The key was not imported; continuing with resource-ID lookup.');
        return empty;
    }

    logger.log('Keymaster key is valid; importing grants into the grants API...');
    try {
        const result = await importValidatedKey(cfxKey);
        logger.log(`Grants API import complete: resources=${result.storedResources}`);
    } catch (error) {
        logger.warn(`Grants API import warning: ${error.message}`);
        logger.warn('Continuing with the grants returned by official Keymaster.');
    }
    return grantsPayload;
}

async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseArguments(argv);
    } catch (error) {
        printUsage();
        throw error;
    }
    if (options.help) {
        printUsage();
        return { failedFiles: 0, failedResources: 0 };
    }

    const inputRoot = path.resolve(options.folder);
    const resources = discoverResourceFolders(inputRoot);
    if (resources.length === 0) {
        throw new Error(`No resource folder containing .fxap was found under ${inputRoot}`);
    }

    let explicitJava = null;
    if (options.javaDirectory) {
        explicitJava = resolveJava(options.javaDirectory);
        if (!explicitJava) {
            throw new Error(`No runnable Java was found in: ${path.resolve(options.javaDirectory)}`);
        }
    }

    const outputRoot = defaultOutputRoot(inputRoot);
    console.log(`Resources: ${resources.length}`);
    console.log(`Output: ${outputRoot}`);
    if (explicitJava) {
        console.log(`Java: ${explicitJava}`);
    }

    const grantsPayload = await loadInitialGrants(options.cfxKey);
    const grantsLookup = options.cfxKey
        ? (resourceId) => fetchResourceGrants(resourceId)
        : createLocalFirstGrantsLookup({
            logger: console,
            remoteLookup: (resourceId) => fetchResourceGrants(resourceId),
        });

    const tempSession = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-decryptor-'));
    let failedFiles = 0;
    let failedResources = 0;
    const resourceResults = [];

    try {
        for (let index = 0; index < resources.length; index += 1) {
            const resourcePath = resources[index];
            const displayName = inputRoot === resourcePath
                ? path.basename(resourcePath)
                : path.relative(inputRoot, resourcePath);
            const outputDir = outputForResource(inputRoot, outputRoot, resourcePath);
            console.log(`[${index + 1}/${resources.length}] ${displayName}`);

            try {
                const decryptor = new FxapDecryptor({
                    clientKeyDeriver: (resourceId, grantsClk) =>
                        deriveClientKey(resourceId, grantsClk),
                    grantsLookup,
                    javaDirectory: options.javaDirectory,
                    log: (message) => console.log(message),
                    outputDir,
                    tempDir: path.join(tempSession, String(index)),
                });
                const stats = await decryptor.decryptResource(resourcePath, grantsPayload);
                failedFiles += stats.failed;
                resourceResults.push({
                    displayName,
                    outputDir,
                    resourcePath,
                    stats,
                    success: stats.failed === 0,
                });
                console.log(`  Done: ${formatStats(stats)}`);
            } catch (error) {
                failedResources += 1;
                resourceResults.push({
                    displayName,
                    error: error.message,
                    outputDir,
                    resourcePath,
                    success: false,
                });
                console.error(`  Failed: ${error.message}`);
            }
        }
    } finally {
        try {
            safeRemoveTemp(tempSession);
        } catch (error) {
            console.warn(`Temporary cleanup warning: ${error.message}`);
        }
    }

    let vertexFix = null;
    if (options.vertexFix) {
        try {
            vertexFix = await repairDecryptedResources(resourceResults, outputRoot, {
                log: (message) => console.log(message),
            });
        } catch (error) {
            vertexFix = {
                enabled: true,
                error: error.message,
                failedFiles: 1,
                outputRoot: '',
                repairedFiles: 0,
                resourcesCopied: 0,
                scannedFiles: 0,
                status: 'failed',
            };
            console.warn(`Model repair failed; decrypted output was not changed: ${error.message}`);
        }
        console.log(
            `Model repair: status=${vertexFix.status} resources=${vertexFix.resourcesCopied} `
            + `scanned=${vertexFix.scannedFiles} repaired=${vertexFix.repairedFiles} `
            + `failed=${vertexFix.failedFiles}`,
        );
        if (vertexFix.outputRoot) {
            console.log(`Model repair output: ${vertexFix.outputRoot}`);
        }
    }

    console.log(
        `Finished: resources=${resources.length} resource-failures=${failedResources} file-failures=${failedFiles}`,
    );
    console.log(`Output: ${outputRoot}`);
    return { failedFiles, failedResources, outputRoot, resourceResults, vertexFix };
}

if (require.main === module) {
    main().then((result) => {
        if (result.failedResources > 0) {
            process.exitCode = 1;
        } else if (result.failedFiles > 0
            || (result.vertexFix && ['failed', 'partial'].includes(result.vertexFix.status))) {
            process.exitCode = 2;
        }
    }).catch((error) => {
        console.error(`Fatal: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    formatStats,
    main,
    loadInitialGrants,
    parseArguments,
    safeRemoveTemp,
};

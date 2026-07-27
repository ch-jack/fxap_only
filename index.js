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

function printUsage() {
    console.log(`
FXAP Decryptor

Usage:
  node . <folder> [java-folder]
  node . <cfx-key> <folder> [java-folder]

Examples:
  node . "D:\\server\\resources\\my_resource"
  node . "D:\\server\\resources" "C:\\Program Files\\Java\\jdk-21"
  node . "cfxk_xxxxxxxxx" "D:\\server\\resources" "C:\\Program Files\\Java\\jdk-21"

The CFX key is optional. Client keys are requested from Cloudflare /v1/derive.
After a CFX key passes official Keymaster validation, its grants are imported
into the Keymaster grants API. Without a key, grants and grants_clk are queried
by resource ID. The client-key derivation formula is not included here.
`);
}

function parseArguments(argv) {
    if (argv.includes('--help') || argv.includes('-h')) {
        return { help: true };
    }
    if (argv.length < 1 || argv.length > 3) {
        throw new Error('Required argument: folder; optional arguments: CFX key and Java folder');
    }

    if (argv.length === 1) {
        return {
            cfxKey: null,
            folder: argv[0],
            help: false,
            javaDirectory: null,
        };
    }

    const [first, second, third] = argv;
    if (first.startsWith('cfxk_')) {
        return {
            cfxKey: first,
            folder: second,
            help: false,
            javaDirectory: third || null,
        };
    }
    if (second.startsWith('cfxk_')) {
        return {
            cfxKey: second,
            folder: first,
            help: false,
            javaDirectory: third || null,
        };
    }
    if (argv.length === 2) {
        return {
            cfxKey: null,
            folder: first,
            help: false,
            javaDirectory: second,
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
        logger.log('No CFX key supplied; using the Keymaster grants API by resource ID.');
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

    const tempSession = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-decryptor-'));
    let failedFiles = 0;
    let failedResources = 0;

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
                    grantsLookup: (resourceId) => fetchResourceGrants(resourceId),
                    javaDirectory: options.javaDirectory,
                    log: (message) => console.log(message),
                    outputDir,
                    tempDir: path.join(tempSession, String(index)),
                });
                const stats = await decryptor.decryptResource(resourcePath, grantsPayload);
                failedFiles += stats.failed;
                console.log(`  Done: ${formatStats(stats)}`);
            } catch (error) {
                failedResources += 1;
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

    console.log(
        `Finished: resources=${resources.length} resource-failures=${failedResources} file-failures=${failedFiles}`,
    );
    console.log(`Output: ${outputRoot}`);
    return { failedFiles, failedResources, outputRoot };
}

if (require.main === module) {
    main().then((result) => {
        if (result.failedResources > 0) {
            process.exitCode = 1;
        } else if (result.failedFiles > 0) {
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

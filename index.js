#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { deriveClientKey, fetchGrantsClk } = require('./src/cloudflare-grants');
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
When Keymaster has no grants_clk for a resource, the authenticated KV fallback
uses CK_GRANTS_CLK_API_TOKEN or the local .env file. The client-key derivation
formula is not included in this repository.
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

    let grantsPayload = { grants: {}, grants_clk: {} };
    if (options.cfxKey) {
        console.log('Requesting grants from the official Cfx.re Keymaster...');
        try {
            grantsPayload = await fetchGrants(options.cfxKey);
        } catch (error) {
            console.warn(`Keymaster warning: ${error.message}`);
            console.warn('Continuing with the authenticated Cloudflare grants fallback.');
        }
    } else {
        console.log('No CFX key supplied; using the authenticated Cloudflare grants fallback.');
    }

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
                    grantsClkLookup: (resourceId) => fetchGrantsClk(resourceId),
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
    parseArguments,
    safeRemoveTemp,
};

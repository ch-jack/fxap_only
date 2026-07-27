'use strict';

const fs = require('fs');
const path = require('path');

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function assertDirectory(folderPath) {
    let stat;
    try {
        stat = fs.statSync(folderPath);
    } catch (_error) {
        throw new Error(`Folder does not exist: ${folderPath}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`Path is not a folder: ${folderPath}`);
    }
}

function hasFxap(folderPath) {
    try {
        return fs.statSync(path.join(folderPath, '.fxap')).isFile();
    } catch (_error) {
        return false;
    }
}

function discoverResourceFolders(inputFolder) {
    const root = path.resolve(inputFolder);
    assertDirectory(root);

    if (hasFxap(root)) {
        return [root];
    }

    const resources = [];
    const pending = [root];
    while (pending.length > 0) {
        const current = pending.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                continue;
            }
            if (IGNORED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            const child = path.join(current, entry.name);
            if (hasFxap(child)) {
                resources.push(child);
            } else {
                pending.push(child);
            }
        }
    }

    return resources.sort((left, right) => left.localeCompare(right));
}

function defaultOutputRoot(inputFolder) {
    const root = path.resolve(inputFolder);
    const folderName = path.basename(root) || 'resources';
    return path.join(path.dirname(root), `${folderName}_decrypted`);
}

function outputForResource(inputRoot, outputRoot, resourceFolder) {
    const resolvedInput = path.resolve(inputRoot);
    const resolvedResource = path.resolve(resourceFolder);
    if (resolvedInput === resolvedResource) {
        return path.resolve(outputRoot);
    }

    const relative = path.relative(resolvedInput, resolvedResource);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Resource escaped the selected folder: ${resolvedResource}`);
    }
    return path.join(path.resolve(outputRoot), relative);
}

module.exports = {
    defaultOutputRoot,
    discoverResourceFolders,
    hasFxap,
    outputForResource,
};

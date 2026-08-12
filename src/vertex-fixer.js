'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const FIXABLE_EXTENSIONS = new Set(['.ydd', '.ydr', '.yft']);
const VERTEX_FIX_DISCLAIMER = [
    '顶点修复不等于模型修复，不一定能 100% 修复模型，',
    '也不保证修复后的模型可以被 FiveM 加载。',
].join('');

function createVertexFixOutputRoot(outputRoot) {
    const resolved = path.resolve(outputRoot);
    const base = path.join(path.dirname(resolved), `${path.basename(resolved)}_顶点修复`);
    if (!fs.existsSync(base)) {
        return base;
    }

    const stamp = new Date().toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .replace(/\..+$/, '');
    for (let suffix = 0; suffix < 1000; suffix += 1) {
        const candidate = `${base}_${stamp}${suffix ? `-${suffix}` : ''}`;
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('无法创建唯一的顶点修复输出目录');
}

function listFixableFiles(root) {
    const files = [];
    const pending = [path.resolve(root)];
    while (pending.length > 0) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(fullPath);
            } else if (entry.isFile() && FIXABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(fullPath);
            }
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

function parseFixerSummary(lines) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = lines[index].match(
            /\[MODEL\]\s+scanned=(\d+),\s*repaired=(\d+),\s*failed=(\d+)/,
        );
        if (match) {
            return {
                failedFiles: Number(match[3]),
                repairedFiles: Number(match[2]),
                scannedFiles: Number(match[1]),
            };
        }
    }
    return { failedFiles: 0, repairedFiles: 0, scannedFiles: 0 };
}

function runFixer(executable, workRoot, options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const spawnProcess = options.spawnProcess || spawn;
    return new Promise((resolve, reject) => {
        const child = spawnProcess(executable, ['fix-models', workRoot], {
            cwd: path.dirname(executable),
            windowsHide: true,
        });
        const lines = [];
        const createCollector = () => {
            const decoder = new StringDecoder('utf8');
            let pending = '';
            const emitLine = (value) => {
                const line = value.replace(/\r$/, '').trimEnd();
                if (!line.trim()) {
                    return;
                }
                lines.push(line);
                log(`  [顶点修复] ${line}`);
            };
            return {
                collect(chunk) {
                    pending += decoder.write(chunk);
                    const complete = pending.split('\n');
                    pending = complete.pop();
                    complete.forEach(emitLine);
                },
                flush() {
                    pending += decoder.end();
                    if (pending) {
                        emitLine(pending);
                    }
                    pending = '';
                },
            };
        };
        const stdoutCollector = createCollector();
        const stderrCollector = createCollector();
        child.stdout?.on('data', (chunk) => stdoutCollector.collect(chunk));
        child.stderr?.on('data', (chunk) => stderrCollector.collect(chunk));
        child.once('error', reject);
        child.once('close', (exitCode) => {
            stdoutCollector.flush();
            stderrCollector.flush();
            resolve({
                exitCode: Number(exitCode ?? 1),
                lines,
                ...parseFixerSummary(lines),
            });
        });
    });
}

function copyDirectoryContents(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
            continue;
        }
        const sourcePath = path.join(source, entry.name);
        const destinationPath = path.join(destination, entry.name);
        if (entry.isDirectory()) {
            copyDirectoryContents(sourcePath, destinationPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
}

async function repairDecryptedResources(resourceResults, outputRoot, options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const successful = (resourceResults || []).filter((item) => {
        if (!item || !item.success || !item.outputDir) {
            return false;
        }
        try {
            return fs.statSync(item.outputDir).isDirectory();
        } catch (_error) {
            return false;
        }
    });
    const result = {
        disclaimer: VERTEX_FIX_DISCLAIMER,
        enabled: true,
        exitCode: null,
        failedFiles: 0,
        outputRoot: '',
        repairedFiles: 0,
        resourcesCopied: 0,
        resourcesEligible: successful.length,
        scannedFiles: 0,
        sourceOutputRoot: path.resolve(outputRoot),
        status: 'pending',
    };
    if (successful.length === 0) {
        result.status = 'skipped';
        log('Vertex fix skipped: no successfully decrypted FXAP resources.');
        return result;
    }

    const executable = path.resolve(
        options.executable || path.join(__dirname, '..', 'tools', 'vertex-fixer', 'FivemDecryptFixer.Cli.exe'),
    );
    let executableExists = false;
    try {
        executableExists = fs.statSync(executable).isFile();
    } catch (_error) {
        executableExists = false;
    }
    if (!executableExists) {
        throw new Error(`缺少顶点修复工具: ${executable}`);
    }

    const fixedRoot = createVertexFixOutputRoot(outputRoot);
    const copyStage = `${fixedRoot}.copying-${process.pid}-${Date.now()}`;
    try {
        fs.mkdirSync(copyStage, { recursive: false });
        for (const item of successful) {
            const resolvedOutput = path.resolve(result.sourceOutputRoot);
            const resolvedResource = path.resolve(item.outputDir);
            const relative = path.relative(resolvedOutput, resolvedResource);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`Resource output escaped the decrypted output root: ${item.outputDir}`);
            }
            if (!relative) {
                copyDirectoryContents(resolvedResource, copyStage);
            } else {
                copyDirectoryContents(resolvedResource, path.join(copyStage, relative));
            }
            result.resourcesCopied += 1;
        }
        fs.renameSync(copyStage, fixedRoot);
    } catch (error) {
        fs.rmSync(copyStage, { force: true, recursive: true });
        throw error;
    }
    result.outputRoot = fixedRoot;
    log(`Vertex fix source remains unchanged: ${path.resolve(outputRoot)}`);
    log(`Vertex fix copy: ${fixedRoot}`);

    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-repair-'));
    try {
        for (const modelPath of listFixableFiles(fixedRoot)) {
            const relative = path.relative(fixedRoot, modelPath);
            const workPath = path.join(workRoot, relative);
            fs.mkdirSync(path.dirname(workPath), { recursive: true });
            fs.copyFileSync(modelPath, workPath);
        }

        const fixer = await runFixer(executable, workRoot, {
            log,
            spawnProcess: options.spawnProcess,
        });
        Object.assign(result, fixer);
        for (const repairedPath of listFixableFiles(workRoot)) {
            const destination = path.join(fixedRoot, path.relative(workRoot, repairedPath));
            fs.copyFileSync(repairedPath, destination);
        }
        if (fixer.exitCode === 0 && fixer.failedFiles === 0) {
            result.status = 'success';
        } else if (fixer.repairedFiles > 0 || result.resourcesCopied > 0) {
            result.status = 'partial';
        } else {
            result.status = 'failed';
        }
    } finally {
        fs.rmSync(workRoot, { force: true, recursive: true });
    }
    return result;
}

module.exports = {
    FIXABLE_EXTENSIONS,
    VERTEX_FIX_DISCLAIMER,
    createVertexFixOutputRoot,
    listFixableFiles,
    parseFixerSummary,
    repairDecryptedResources,
    runFixer,
};

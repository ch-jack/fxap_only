'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TOOLS_DIR } = require('./constants');

const UNLUAC_JAR = path.join(TOOLS_DIR, 'unluac54.jar');
const MAX_PROCESS_OUTPUT = 128 * 1024 * 1024;

function javaExecutableName() {
    return process.platform === 'win32' ? 'java.exe' : 'java';
}

function canRun(command) {
    try {
        const result = spawnSync(command, ['-version'], {
            encoding: 'utf8',
            timeout: 10_000,
            windowsHide: true,
        });
        return result.status === 0;
    } catch (_error) {
        return false;
    }
}

function javaCandidates(javaDirectory = null) {
    const executable = javaExecutableName();
    const candidates = [];
    const add = (candidate) => {
        if (candidate && !candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    };

    if (javaDirectory) {
        const resolved = path.resolve(javaDirectory);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Java path does not exist: ${resolved}`);
        }

        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
            add(resolved);
        } else if (stat.isDirectory()) {
            // Accept either a JDK/JRE root or its bin directory.
            add(path.join(resolved, 'bin', executable));
            add(path.join(resolved, executable));
        }
        return candidates;
    }

    if (process.env.JAVA_HOME) {
        add(path.join(path.resolve(process.env.JAVA_HOME), 'bin', executable));
    }
    add('java');
    return candidates;
}

function resolveJava(javaDirectory = null) {
    for (const candidate of javaCandidates(javaDirectory)) {
        if (canRun(candidate)) {
            return candidate;
        }
    }
    return null;
}

function runProcess(command, args, options = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd,
                windowsHide: true,
            });
        } catch (error) {
            resolve({ code: null, error, stderr: '', stdout: Buffer.alloc(0) });
            return;
        }

        const stdout = [];
        const stderr = [];
        let stdoutLength = 0;
        let stderrLength = 0;
        let outputLimitError = null;

        child.stdout.on('data', (chunk) => {
            stdoutLength += chunk.length;
            if (stdoutLength > MAX_PROCESS_OUTPUT) {
                outputLimitError = new Error('Java output exceeded the 128 MB safety limit');
                child.kill();
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderrLength += chunk.length;
            if (stderrLength <= MAX_PROCESS_OUTPUT) {
                stderr.push(chunk);
            }
        });
        child.on('error', (error) => {
            resolve({ code: null, error, stderr: '', stdout: Buffer.alloc(0) });
        });
        child.on('close', (code) => {
            resolve({
                code,
                error: outputLimitError,
                stderr: Buffer.concat(stderr).toString('utf8'),
                stdout: Buffer.concat(stdout),
            });
        });
    });
}

function findClosestLabel(assembly, jumpLineIndex, unknownLabel) {
    const lines = assembly.split(/\r?\n/);
    const target = Number.parseInt(String(unknownLabel).replace(/^l/, ''), 10);
    const labels = [];

    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/\.label\s+l(\d+)/);
        if (match) {
            labels.push({
                label: `l${match[1]}`,
                line: index,
                number: Number.parseInt(match[1], 10),
            });
        }
    }

    if (labels.length === 0) {
        return null;
    }
    const exact = labels.find((label) => label.number === target);
    if (exact) {
        return exact.label;
    }
    const next = labels.find((label) => label.line > jumpLineIndex);
    if (next) {
        return next.label;
    }

    return labels.reduce((closest, label) => (
        Math.abs(label.number - target) < Math.abs(closest.number - target)
            ? label
            : closest
    )).label;
}

function fixUnknownLabels(assemblyPath) {
    const assembly = fs.readFileSync(assemblyPath, 'utf8');
    const lines = assembly.split(/\r?\n/);
    const existing = new Set();

    for (const line of lines) {
        const match = line.match(/\.label\s+(l\d+)/);
        if (match) {
            existing.add(match[1]);
        }
    }

    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].trim().match(/^jmp\s+(\d+|l\d+)$/);
        if (!match) {
            continue;
        }

        const target = match[1].startsWith('l') ? match[1] : `l${match[1]}`;
        if (existing.has(target)) {
            continue;
        }

        const replacement = findClosestLabel(assembly, index, match[1]);
        if (replacement && existing.has(replacement)) {
            lines[index] = lines[index].replace(
                /jmp\s+(\d+|l\d+)/,
                `jmp          ${replacement}`,
            );
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(assemblyPath, lines.join('\n'), 'utf8');
    }
    return changed;
}

function fallbackPaths(outputPath) {
    const bytecodePath = outputPath.toLowerCase().endsWith('.lua')
        ? `${outputPath}c`
        : `${outputPath}.luac`;
    const assemblyPath = outputPath.toLowerCase().endsWith('.lua')
        ? outputPath.replace(/\.lua$/i, '.asm')
        : `${outputPath}.asm`;
    return { assemblyPath, bytecodePath };
}

class JavaDecompiler {
    constructor(tempRoot, options = {}) {
        this.tempRoot = path.resolve(tempRoot);
        this.javaDirectory = options.javaDirectory || null;
        this.java = undefined;
        this.queue = Promise.resolve();
    }

    decompile(bytecode, outputPath, relativeName) {
        const job = this.queue.then(() => this.#decompile(bytecode, outputPath, relativeName));
        this.queue = job.catch(() => {});
        return job;
    }

    async #assembleWithFixes(java, assemblyPath, fixedBytecodePath) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const assembled = await runProcess(java, [
                '-jar',
                UNLUAC_JAR,
                '--assemble',
                assemblyPath,
                '-o',
                fixedBytecodePath,
            ]);
            if (assembled.code === 0 && fs.existsSync(fixedBytecodePath)) {
                return true;
            }
            if (!fixUnknownLabels(assemblyPath)) {
                return false;
            }
        }
        return false;
    }

    async #saveFallback(bytecode, outputPath, assemblySource, reason) {
        const paths = fallbackPaths(outputPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.rmSync(outputPath, { force: true });
        fs.writeFileSync(paths.bytecodePath, bytecode);
        if (assemblySource && fs.existsSync(assemblySource)) {
            fs.copyFileSync(assemblySource, paths.assemblyPath);
        }
        return {
            ...paths,
            reason,
            success: false,
        };
    }

    async #decompile(bytecode, outputPath, relativeName) {
        if (!fs.existsSync(UNLUAC_JAR)) {
            return this.#saveFallback(bytecode, outputPath, null, 'unluac54.jar is missing');
        }

        if (this.java === undefined) {
            try {
                this.java = resolveJava(this.javaDirectory);
            } catch (error) {
                return this.#saveFallback(bytecode, outputPath, null, error.message);
            }
        }
        if (!this.java) {
            const reason = this.javaDirectory
                ? `No runnable Java was found in: ${path.resolve(this.javaDirectory)}`
                : 'Java is unavailable; install Java 8+, set JAVA_HOME, or pass a Java directory';
            return this.#saveFallback(bytecode, outputPath, null, reason);
        }

        const safeRelativeName = relativeName.replace(/^[\\/]+/, '');
        const bytecodePath = path.resolve(this.tempRoot, `${safeRelativeName}c`);
        const relativeBytecodePath = path.relative(this.tempRoot, bytecodePath);
        if (!relativeBytecodePath
            || relativeBytecodePath.startsWith('..')
            || path.isAbsolute(relativeBytecodePath)) {
            return this.#saveFallback(bytecode, outputPath, null, 'Invalid Lua relative path');
        }

        const assemblyPath = path.resolve(this.tempRoot, `${safeRelativeName}.asm`);
        const fixedBytecodePath = path.resolve(this.tempRoot, `${safeRelativeName}.fixed.luac`);
        fs.mkdirSync(path.dirname(bytecodePath), { recursive: true });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(bytecodePath, bytecode);

        const direct = await runProcess(this.java, ['-jar', UNLUAC_JAR, bytecodePath]);
        if (!direct.error && direct.code === 0 && direct.stdout.length >= 10) {
            fs.writeFileSync(outputPath, direct.stdout);
            return { success: true, usedRepair: false };
        }

        const disassembled = await runProcess(this.java, [
            '-jar',
            UNLUAC_JAR,
            '--disassemble',
            bytecodePath,
            '-o',
            assemblyPath,
        ]);
        if (disassembled.code !== 0 || !fs.existsSync(assemblyPath)) {
            return this.#saveFallback(
                bytecode,
                outputPath,
                null,
                'unluac could not decompile or disassemble the Lua bytecode',
            );
        }

        const assembled = await this.#assembleWithFixes(
            this.java,
            assemblyPath,
            fixedBytecodePath,
        );
        if (assembled) {
            const repaired = await runProcess(this.java, [
                '-jar',
                UNLUAC_JAR,
                fixedBytecodePath,
            ]);
            if (!repaired.error && repaired.code === 0 && repaired.stdout.length >= 10) {
                fs.writeFileSync(outputPath, repaired.stdout);
                return { success: true, usedRepair: true };
            }
        }

        return this.#saveFallback(
            bytecode,
            outputPath,
            assemblyPath,
            'unluac decompilation failed; bytecode and assembly were preserved',
        );
    }
}

module.exports = {
    JavaDecompiler,
    fallbackPaths,
    findClosestLabel,
    fixUnknownLabels,
    javaCandidates,
    resolveJava,
    runProcess,
};

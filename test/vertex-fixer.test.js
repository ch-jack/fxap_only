'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const {
    createVertexFixOutputRoot,
    parseFixerSummary,
    repairDecryptedResources,
    runFixer,
} = require('../src/vertex-fixer');

test('creates a non-overwriting sibling vertex-fix directory', (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-dir-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const output = path.join(root, 'resource_decrypted');
    fs.mkdirSync(output);
    const first = createVertexFixOutputRoot(output);
    assert.equal(first, path.join(root, 'resource_decrypted_顶点修复'));
    fs.mkdirSync(first);
    assert.notEqual(createVertexFixOutputRoot(output), first);
});

test('parses the CLI repair summary', () => {
    assert.deepEqual(parseFixerSummary([
        'noise',
        '[MODEL] scanned=5, repaired=4, failed=1',
    ]), { failedFiles: 1, repairedFiles: 4, scannedFiles: 5 });
});

test('buffers split UTF-8 output and split repair summary lines', async () => {
    const messages = [];
    const spawnProcess = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
            const output = Buffer.from('正在修复顶点\n[MODEL] scanned=2, repaired=1, failed=1\n');
            child.stdout.emit('data', output.subarray(0, 5));
            child.stdout.emit('data', output.subarray(5, 31));
            child.stdout.emit('data', output.subarray(31));
            child.emit('close', 2);
        });
        return child;
    };

    const result = await runFixer('FivemDecryptFixer.Cli.exe', 'D:\\work', {
        log: (message) => messages.push(message),
        spawnProcess,
    });

    assert.equal(result.exitCode, 2);
    assert.deepEqual({
        failedFiles: result.failedFiles,
        repairedFiles: result.repairedFiles,
        scannedFiles: result.scannedFiles,
    }, { failedFiles: 1, repairedFiles: 1, scannedFiles: 2 });
    assert.equal(messages.length, 2);
    assert.match(messages[0], /正在修复顶点/);
});

test('marks a zero-exit fixer with failed files as partial', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-summary-fail-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const output = path.join(root, 'resource_decrypted');
    const executable = path.join(root, 'FivemDecryptFixer.Cli.exe');
    fs.mkdirSync(path.join(output, 'stream'), { recursive: true });
    fs.writeFileSync(path.join(output, 'stream', 'model.ydr'), 'model');
    fs.writeFileSync(executable, 'test');

    const spawnProcess = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
            child.stdout.emit('data', Buffer.from('[MODEL] scanned=1, repaired=0, failed=1\n'));
            child.emit('close', 0);
        });
        return child;
    };
    const result = await repairDecryptedResources([{
        outputDir: output,
        success: true,
    }], output, { executable, spawnProcess });

    assert.equal(result.status, 'partial');
    assert.equal(result.failedFiles, 1);
});

test('copies complete successful resources and repairs only the sibling copy', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-test-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const output = path.join(root, 'resources_decrypted');
    const resource = path.join(output, 'nested', 'resource_a');
    const executable = path.join(root, 'FivemDecryptFixer.Cli.exe');
    fs.mkdirSync(path.join(resource, 'stream'), { recursive: true });
    fs.writeFileSync(path.join(resource, 'fxmanifest.lua'), 'manifest');
    fs.writeFileSync(path.join(resource, 'stream', 'model.ydr'), 'original-model');
    fs.writeFileSync(executable, 'test');

    const spawnProcess = (_exe, arguments_) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
            const workRoot = arguments_[1];
            fs.writeFileSync(path.join(workRoot, 'nested', 'resource_a', 'stream', 'model.ydr'), 'fixed-model');
            child.stdout.emit('data', Buffer.from('[MODEL] scanned=1, repaired=1, failed=0\n'));
            child.emit('close', 0);
        });
        return child;
    };
    const result = await repairDecryptedResources([{
        outputDir: resource,
        success: true,
    }], output, { executable, spawnProcess });

    assert.equal(result.status, 'success');
    assert.equal(result.resourcesCopied, 1);
    assert.equal(result.repairedFiles, 1);
    assert.equal(fs.readFileSync(path.join(resource, 'stream', 'model.ydr'), 'utf8'), 'original-model');
    assert.equal(
        fs.readFileSync(path.join(result.outputRoot, 'nested', 'resource_a', 'stream', 'model.ydr'), 'utf8'),
        'fixed-model',
    );
    assert.equal(
        fs.readFileSync(path.join(result.outputRoot, 'nested', 'resource_a', 'fxmanifest.lua'), 'utf8'),
        'manifest',
    );
});

test('copies a directly selected resource into the fixed root without recursive self-copy', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-single-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const output = path.join(root, 'resource_decrypted');
    const executable = path.join(root, 'FivemDecryptFixer.Cli.exe');
    fs.mkdirSync(path.join(output, 'stream'), { recursive: true });
    fs.writeFileSync(path.join(output, 'fxmanifest.lua'), 'manifest');
    fs.writeFileSync(path.join(output, 'stream', 'model.ydr'), 'original-model');
    fs.writeFileSync(executable, 'test');

    const spawnProcess = (_exe, arguments_) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
            const workRoot = arguments_[1];
            fs.writeFileSync(path.join(workRoot, 'stream', 'model.ydr'), 'fixed-model');
            child.stdout.emit('data', Buffer.from('[MODEL] scanned=1, repaired=1, failed=0\n'));
            child.emit('close', 0);
        });
        return child;
    };
    const result = await repairDecryptedResources([{
        outputDir: output,
        success: true,
    }], output, { executable, spawnProcess });

    assert.equal(fs.readFileSync(path.join(output, 'stream', 'model.ydr'), 'utf8'), 'original-model');
    assert.equal(fs.readFileSync(path.join(result.outputRoot, 'stream', 'model.ydr'), 'utf8'), 'fixed-model');
    assert.equal(fs.readFileSync(path.join(result.outputRoot, 'fxmanifest.lua'), 'utf8'), 'manifest');
});

test('does not expose an incomplete vertex-fix directory when the copy fails', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fxap-vertex-copy-fail-'));
    context.after(() => fs.rmSync(root, { force: true, recursive: true }));
    const output = path.join(root, 'resources_decrypted');
    const resource = path.join(output, 'resource_a');
    const outside = path.join(root, 'outside_resource');
    const executable = path.join(root, 'FivemDecryptFixer.Cli.exe');
    fs.mkdirSync(resource, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(resource, 'fxmanifest.lua'), 'manifest');
    fs.writeFileSync(path.join(outside, 'fxmanifest.lua'), 'outside');
    fs.writeFileSync(executable, 'test');

    await assert.rejects(
        repairDecryptedResources([{
            outputDir: resource,
            success: true,
        }, {
            outputDir: outside,
            success: true,
        }], output, { executable }),
    );

    assert.equal(fs.existsSync(path.join(root, 'resources_decrypted_顶点修复')), false);
    assert.deepEqual(
        fs.readdirSync(root).filter((name) => name.includes('.copying-')),
        [],
    );
});

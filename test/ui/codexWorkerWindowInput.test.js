'use strict';

const { randomUUID } = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTextAndEnterInputs,
  findWorkerWindow
} = require('../../src/native/windows/CodexWorkerWindowInput');

test('worker input uses Unicode key events and a final Enter without the clipboard', () => {
  const inputs = buildTextAndEnterInputs('тест');

  assert.equal(inputs.length, 10);
  assert.deepEqual(
    inputs.slice(0, 8).map((input) => input.data.ki.wScan),
    [0x0442, 0x0442, 0x0435, 0x0435, 0x0441, 0x0441, 0x0442, 0x0442]
  );
  assert.equal(inputs.at(-2).data.ki.wVk, 0x0d);
  assert.equal(inputs.at(-1).data.ki.wVk, 0x0d);
});

test('worker input refuses an unmatched VS Code window title', {
  skip: process.platform !== 'win32'
}, () => {
  assert.throws(
    () => findWorkerWindow(`missing-worker-${randomUUID()}`),
    /Could not find the dedicated VS Code worker window/i
  );
});

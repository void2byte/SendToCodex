'use strict';

const koffi = require('./vendor/koffi');

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const SW_RESTORE = 9;
const VK_RETURN = 0x0d;

const HANDLE = koffi.pointer('CODEX_WORKER_HANDLE', koffi.opaque());
const HWND = koffi.alias('CODEX_WORKER_HWND', HANDLE);
const MOUSEINPUT = koffi.struct('CODEX_WORKER_MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
});
const KEYBDINPUT = koffi.struct('CODEX_WORKER_KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t'
});
const HARDWAREINPUT = koffi.struct('CODEX_WORKER_HARDWAREINPUT', {
  uMsg: 'uint32_t',
  wParamL: 'uint16_t',
  wParamH: 'uint16_t'
});
const INPUT_UNION = koffi.union('CODEX_WORKER_INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT
});
const INPUT = koffi.struct('CODEX_WORKER_INPUT', {
  type: 'uint32_t',
  data: INPUT_UNION
});
const EnumWindowsProc = koffi.proto(
  'bool __stdcall CodexWorkerEnumWindowsProc(CODEX_WORKER_HWND hWnd, intptr_t lParam)'
);

let api = null;

function loadApi() {
  if (process.platform !== 'win32') {
    throw new Error(
      'Codex extension UI counter activation currently requires Windows. Use the app-server method on this platform.'
    );
  }
  if (api) {
    return api;
  }

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    AttachThreadInput: user32.func(
      'bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)'
    ),
    BringWindowToTop: user32.func(
      'bool __stdcall BringWindowToTop(CODEX_WORKER_HWND hWnd)'
    ),
    EnumWindows: user32.func(
      'bool __stdcall EnumWindows(CodexWorkerEnumWindowsProc *lpEnumFunc, intptr_t lParam)'
    ),
    GetClassNameW: user32.func(
      'int __stdcall GetClassNameW(CODEX_WORKER_HWND hWnd, _Out_ char16_t *lpClassName, int nMaxCount)'
    ),
    GetCurrentThreadId: kernel32.func(
      'uint32_t __stdcall GetCurrentThreadId(void)'
    ),
    GetForegroundWindow: user32.func(
      'CODEX_WORKER_HWND __stdcall GetForegroundWindow(void)'
    ),
    GetWindowTextLengthW: user32.func(
      'int __stdcall GetWindowTextLengthW(CODEX_WORKER_HWND hWnd)'
    ),
    GetWindowTextW: user32.func(
      'int __stdcall GetWindowTextW(CODEX_WORKER_HWND hWnd, _Out_ char16_t *lpString, int nMaxCount)'
    ),
    GetWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(CODEX_WORKER_HWND hWnd, _Out_ uint32_t *lpdwProcessId)'
    ),
    IsWindowVisible: user32.func(
      'bool __stdcall IsWindowVisible(CODEX_WORKER_HWND hWnd)'
    ),
    SendInput: user32.func(
      'uint32_t __stdcall SendInput(uint32_t cInputs, const CODEX_WORKER_INPUT *pInputs, int cbSize)'
    ),
    SetForegroundWindow: user32.func(
      'bool __stdcall SetForegroundWindow(CODEX_WORKER_HWND hWnd)'
    ),
    ShowWindow: user32.func(
      'bool __stdcall ShowWindow(CODEX_WORKER_HWND hWnd, int nCmdShow)'
    )
  };
  return api;
}

function getPointerAddress(pointer) {
  return pointer ? koffi.address(pointer) : 0n;
}

function getWindowId(windowHandle) {
  return getPointerAddress(windowHandle).toString(16);
}

function readWindowString(windowHandle, length, reader) {
  const buffer = koffi.alloc('char16_t', length + 1);
  const copied = reader(windowHandle, buffer, length + 1);
  return copied > 0 ? koffi.decode(buffer, 'char16_t', copied) : '';
}

function listVisibleCodeWindows() {
  const loaded = loadApi();
  const windows = [];
  const callback = koffi.register((windowHandle) => {
    if (!loaded.IsWindowVisible(windowHandle)) {
      return true;
    }
    const titleLength = loaded.GetWindowTextLengthW(windowHandle);
    if (titleLength <= 0) {
      return true;
    }
    const className = readWindowString(
      windowHandle,
      255,
      loaded.GetClassNameW
    );
    if (className !== 'Chrome_WidgetWin_1') {
      return true;
    }
    const title = readWindowString(
      windowHandle,
      titleLength,
      loaded.GetWindowTextW
    );
    windows.push({ windowHandle, title });
    return true;
  }, koffi.pointer(EnumWindowsProc));

  try {
    loaded.EnumWindows(callback, 0);
  } finally {
    koffi.unregister(callback);
  }
  return windows;
}

function findWorkerWindow(titleToken) {
  const normalizedToken = String(titleToken || '').trim().toLocaleLowerCase();
  if (!normalizedToken) {
    throw new Error('A unique worker-window title token is required.');
  }
  const matches = listVisibleCodeWindows().filter(({ title }) =>
    String(title).toLocaleLowerCase().includes(normalizedToken)
  );
  if (matches.length === 0) {
    throw new Error(
      `Could not find the dedicated VS Code worker window (${titleToken}).`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one VS Code window matched the worker token (${titleToken}); refusing to send keyboard input.`
    );
  }
  return matches[0];
}

function focusWindow(windowHandle) {
  const loaded = loadApi();
  const processId = koffi.alloc('uint32_t', 1);
  const targetThreadId = loaded.GetWindowThreadProcessId(windowHandle, processId);
  const currentThreadId = loaded.GetCurrentThreadId();
  let attached = false;
  try {
    if (targetThreadId && currentThreadId && targetThreadId !== currentThreadId) {
      attached = loaded.AttachThreadInput(currentThreadId, targetThreadId, true);
    }
    loaded.ShowWindow(windowHandle, SW_RESTORE);
    loaded.BringWindowToTop(windowHandle);
    loaded.SetForegroundWindow(windowHandle);
  } finally {
    if (attached) {
      loaded.AttachThreadInput(currentThreadId, targetThreadId, false);
    }
  }
  return (
    getPointerAddress(loaded.GetForegroundWindow()) ===
    getPointerAddress(windowHandle)
  );
}

function focusWorkerWindow(titleToken, expectedWindowId) {
  const target = findWorkerWindow(titleToken);
  const windowId = getWindowId(target.windowHandle);
  if (expectedWindowId && String(expectedWindowId) !== windowId) {
    throw new Error(
      'The dedicated Codex worker window changed while opening the activation chat; refusing to continue.'
    );
  }
  if (!focusWindow(target.windowHandle)) {
    throw new Error(
      'Windows did not grant focus to the dedicated VS Code worker window.'
    );
  }
  return {
    title: target.title,
    windowId
  };
}

function keyboardInput(wVk, wScan, dwFlags) {
  return {
    type: INPUT_KEYBOARD,
    data: {
      ki: {
        wVk,
        wScan,
        dwFlags,
        time: 0,
        dwExtraInfo: 0
      }
    }
  };
}

function buildTextAndEnterInputs(text) {
  const inputs = [];
  for (const character of String(text || '')) {
    const utf16 = Buffer.from(character, 'utf16le');
    for (let offset = 0; offset < utf16.length; offset += 2) {
      const codeUnit = utf16.readUInt16LE(offset);
      inputs.push(keyboardInput(0, codeUnit, KEYEVENTF_UNICODE));
      inputs.push(
        keyboardInput(0, codeUnit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
      );
    }
  }
  inputs.push(keyboardInput(VK_RETURN, 0, 0));
  inputs.push(keyboardInput(VK_RETURN, 0, KEYEVENTF_KEYUP));
  return inputs;
}

function sendTextAndEnterToWorkerWindow(titleToken, text, options = {}) {
  const normalizedText = String(text || '');
  if (!normalizedText) {
    throw new Error('Cannot submit an empty Codex activation prompt.');
  }
  const loaded = loadApi();
  const target = findWorkerWindow(titleToken);
  const windowId = getWindowId(target.windowHandle);
  if (
    options.expectedWindowId &&
    String(options.expectedWindowId) !== windowId
  ) {
    throw new Error(
      'The activation chat is no longer owned by the original worker window; no input was sent.'
    );
  }
  if (!focusWindow(target.windowHandle)) {
    throw new Error(
      'Windows did not grant focus to the dedicated VS Code worker window; no input was sent.'
    );
  }
  if (
    getPointerAddress(loaded.GetForegroundWindow()) !==
    getPointerAddress(target.windowHandle)
  ) {
    throw new Error(
      'The dedicated VS Code worker window lost focus before input; no input was sent.'
    );
  }

  const inputs = buildTextAndEnterInputs(normalizedText);
  const sent = loaded.SendInput(inputs.length, inputs, koffi.sizeof(INPUT));
  if (sent !== inputs.length) {
    throw new Error(
      `Windows accepted ${sent}/${inputs.length} activation keystrokes.`
    );
  }
  return { title: target.title, windowId, inputCount: sent };
}

module.exports = {
  buildTextAndEnterInputs,
  findWorkerWindow,
  focusWorkerWindow,
  listVisibleCodeWindows,
  sendTextAndEnterToWorkerWindow
};

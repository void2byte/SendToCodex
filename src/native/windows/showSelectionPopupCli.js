'use strict';

const koffi = require('./vendor/koffi');

const ACTION_BUTTON_ID = 1001;
const CLOSE_BUTTON_ID = 1002;
const WINDOW_WIDTH = 146;
const WINDOW_HEIGHT = 28;
const OUTER_MARGIN = 2;
const CLOSE_BUTTON_WIDTH = 24;
const MAIN_BUTTON_WIDTH = WINDOW_WIDTH - CLOSE_BUTTON_WIDTH - OUTER_MARGIN * 3;
const BUTTON_HEIGHT = WINDOW_HEIGHT - OUTER_MARGIN * 2;

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_POPUP = 0x80000000;
const WS_TABSTOP = 0x00010000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const SW_SHOWNOACTIVATE = 4;
const COLOR_3DFACE = 15;
const WM_ACTIVATE = 0x0006;
const WM_CLOSE = 0x0010;
const WM_COMMAND = 0x0111;
const WM_DESTROY = 0x0002;
const WM_TIMER = 0x0113;
const WA_INACTIVE = 0;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const CLICK_POLL_TIMER_ID = 1;
const CLICK_POLL_INTERVAL_MS = 40;

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HBRUSH = koffi.alias('HBRUSH', HANDLE);
const HCURSOR = koffi.alias('HCURSOR', HANDLE);
const HINSTANCE = HANDLE;
const POINT = koffi.struct('POINT', {
  x: 'long',
  y: 'long'
});
const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long'
});
const MSG = koffi.struct('MSG', {
  hwnd: HWND,
  message: 'uint32_t',
  wParam: 'uintptr_t',
  lParam: 'intptr_t',
  time: 'uint32_t',
  pt: POINT,
  lPrivate: 'uint32_t'
});
const WindowProc = koffi.proto(
  'intptr_t __stdcall WindowProc(HWND hWnd, uint32_t uMsg, uintptr_t wParam, intptr_t lParam)'
);
const WNDCLASSW = koffi.struct('WNDCLASSW', {
  style: 'uint32_t',
  lpfnWndProc: koffi.pointer(WindowProc),
  cbClsExtra: 'int',
  cbWndExtra: 'int',
  hInstance: HINSTANCE,
  hIcon: HANDLE,
  hCursor: HCURSOR,
  hbrBackground: HBRUSH,
  lpszMenuName: 'const char16_t *',
  lpszClassName: 'const char16_t *'
});

const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : null;
const kernel32 = process.platform === 'win32' ? koffi.load('kernel32.dll') : null;

const CreateWindowExW =
  user32 &&
  user32.func(
    'HWND __stdcall CreateWindowExW(uint32_t dwExStyle, const char16_t *lpClassName, const char16_t *lpWindowName, uint32_t dwStyle, int x, int y, int nWidth, int nHeight, HWND hWndParent, uintptr_t hMenu, void *hInstance, void *lpParam)'
  );
const DefWindowProcW =
  user32 &&
  user32.func(
    'intptr_t __stdcall DefWindowProcW(HWND hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)'
  );
const DestroyWindow = user32 && user32.func('bool __stdcall DestroyWindow(HWND hWnd)');
const DispatchMessageW = user32 && user32.func('intptr_t __stdcall DispatchMessageW(const MSG *lpMsg)');
const GetAsyncKeyState = user32 && user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
const GetCursorPos = user32 && user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pos)');
const GetWindowRect =
  user32 && user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)');
const GetMessageW =
  user32 &&
  user32.func(
    'int __stdcall GetMessageW(_Out_ MSG *lpMsg, HWND hWnd, uint32_t wMsgFilterMin, uint32_t wMsgFilterMax)'
  );
const GetSysColorBrush =
  user32 && user32.func('HBRUSH __stdcall GetSysColorBrush(int nIndex)');
const KillTimer = user32 && user32.func('bool __stdcall KillTimer(HWND hWnd, uintptr_t uIDEvent)');
const PostQuitMessage = user32 && user32.func('void __stdcall PostQuitMessage(int nExitCode)');
const RegisterClassW =
  user32 && user32.func('uint16_t __stdcall RegisterClassW(const WNDCLASSW *lpWndClass)');
const SetTimer =
  user32 &&
  user32.func(
    'uintptr_t __stdcall SetTimer(HWND hWnd, uintptr_t nIDEvent, uint32_t uElapse, void *lpTimerFunc)'
  );
const ShowWindow = user32 && user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)');
const TranslateMessage = user32 && user32.func('bool __stdcall TranslateMessage(const MSG *lpMsg)');
const UnregisterClassW =
  user32 &&
  user32.func('bool __stdcall UnregisterClassW(const char16_t *lpClassName, void *hInstance)');
const GetLastError = kernel32 && kernel32.func('uint32_t __stdcall GetLastError(void)');
const GetModuleHandleW =
  kernel32 &&
  kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *lpModuleName)');

function buildActionLabel(payload) {
  return String((payload && payload.label) || 'Send to Codex').trim() || 'Send to Codex';
}

function getWindowPosition(payload) {
  const position = {};

  if (!GetCursorPos(position)) {
    throw new Error(`GetCursorPos failed with error ${readLastError()}.`);
  }

  position.x += Number((payload && payload.offsetX) || 10);
  position.y += Number((payload && payload.offsetY) || 14);
  return position;
}

function readLastError() {
  return GetLastError ? Number(GetLastError()) : -1;
}

function showPopupAction(payload) {
  if (process.platform !== 'win32') {
    return {
      action: 'unsupported',
      message: 'Native selection popup is only available on Windows.'
    };
  }

  const moduleHandle = GetModuleHandleW ? GetModuleHandleW(null) : null;
  const className = 'CodexTerminalRecorderPopupButton';
  const popupState = {
    closing: false,
    mousePressed: false,
    result: { action: 'dismiss' },
    windowHandle: null
  };

  const windowProc = koffi.register((hWnd, message, wParam, lParam) => {
    switch (message) {
      case WM_COMMAND: {
        const commandId = Number(wParam) & 0xffff;
        if (commandId === ACTION_BUTTON_ID) {
          closePopup(popupState, 'invoke');
          return 0;
        }
        if (commandId === CLOSE_BUTTON_ID) {
          closePopup(popupState, 'skip');
          return 0;
        }
        break;
      }
      case WM_ACTIVATE:
        if ((Number(wParam) & 0xffff) === WA_INACTIVE) {
          closePopup(popupState, 'dismiss');
          return 0;
        }
        break;
      case WM_CLOSE:
        closePopup(popupState, 'dismiss');
        return 0;
      case WM_TIMER:
        if (Number(wParam) === CLICK_POLL_TIMER_ID) {
          pollForOutsideClick(popupState);
          return 0;
        }
        break;
      case WM_DESTROY:
        popupState.windowHandle = null;
        if (PostQuitMessage) {
          PostQuitMessage(0);
        }
        return 0;
      default:
        break;
    }

    return DefWindowProcW ? DefWindowProcW(hWnd, message, wParam, lParam) : 0;
  }, koffi.pointer(WindowProc));

  let classRegistered = false;

  try {
    const windowClass = {
      style: 0,
      lpfnWndProc: windowProc,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: moduleHandle,
      hIcon: null,
      hCursor: null,
      hbrBackground: GetSysColorBrush ? GetSysColorBrush(COLOR_3DFACE) : null,
      lpszMenuName: null,
      lpszClassName: className
    };

    if (!RegisterClassW || !RegisterClassW(windowClass)) {
      return {
        action: 'error',
        message: `RegisterClassW failed with error ${readLastError()}.`
      };
    }
    classRegistered = true;

    const position = getWindowPosition(payload);
    const windowHandle = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
      className,
      '',
      WS_POPUP | WS_CLIPCHILDREN,
      position.x,
      position.y,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      null,
      0,
      moduleHandle,
      null
    );

    if (!windowHandle) {
      return {
        action: 'error',
        message: `CreateWindowExW failed with error ${readLastError()}.`
      };
    }

    popupState.windowHandle = windowHandle;

    const actionButton = CreateWindowExW(
      0,
      'BUTTON',
      buildActionLabel(payload),
      WS_CHILD | WS_VISIBLE | WS_TABSTOP,
      OUTER_MARGIN,
      OUTER_MARGIN,
      MAIN_BUTTON_WIDTH,
      BUTTON_HEIGHT,
      windowHandle,
      ACTION_BUTTON_ID,
      moduleHandle,
      null
    );

    if (!actionButton) {
      closePopup(popupState, 'dismiss');
      return {
        action: 'error',
        message: `CreateWindowExW failed while creating the action button with error ${readLastError()}.`
      };
    }

    const closeButton = CreateWindowExW(
      0,
      'BUTTON',
      '\u00D7',
      WS_CHILD | WS_VISIBLE | WS_TABSTOP,
      OUTER_MARGIN * 2 + MAIN_BUTTON_WIDTH,
      OUTER_MARGIN,
      CLOSE_BUTTON_WIDTH,
      BUTTON_HEIGHT,
      windowHandle,
      CLOSE_BUTTON_ID,
      moduleHandle,
      null
    );

    if (!closeButton) {
      closePopup(popupState, 'dismiss');
      return {
        action: 'error',
        message: `CreateWindowExW failed while creating the close button with error ${readLastError()}.`
      };
    }

    popupState.mousePressed = isAnyMouseButtonPressed();

    const timerHandle = SetTimer
      ? SetTimer(windowHandle, CLICK_POLL_TIMER_ID, CLICK_POLL_INTERVAL_MS, null)
      : 0;

    if (!timerHandle) {
      closePopup(popupState, 'dismiss');
      return {
        action: 'error',
        message: `SetTimer failed with error ${readLastError()}.`
      };
    }

    if (ShowWindow) {
      // Keep focus in VS Code so the popup does not interrupt typing/editing.
      ShowWindow(windowHandle, SW_SHOWNOACTIVATE);
    }

    const message = {};
    let messageResult = 0;

    while (GetMessageW && (messageResult = GetMessageW(message, null, 0, 0)) > 0) {
      if (TranslateMessage) {
        TranslateMessage(message);
      }
      if (DispatchMessageW) {
        DispatchMessageW(message);
      }
    }

    if (messageResult === -1) {
      return {
        action: 'error',
        message: `GetMessageW failed with error ${readLastError()}.`
      };
    }

    return popupState.result;
  } catch (error) {
    return {
      action: 'error',
      message: error && error.message ? error.message : String(error)
    };
  } finally {
    if (popupState.windowHandle && KillTimer) {
      KillTimer(popupState.windowHandle, CLICK_POLL_TIMER_ID);
    }

    if (popupState.windowHandle && DestroyWindow) {
      DestroyWindow(popupState.windowHandle);
    }

    if (classRegistered && UnregisterClassW) {
      UnregisterClassW(className, moduleHandle);
    }

    if (windowProc) {
      koffi.unregister(windowProc);
    }
  }
}

function closePopup(popupState, action) {
  if (action === 'invoke' || action === 'skip') {
    popupState.result.action = action;
  } else if (!popupState.result || popupState.result.action !== 'invoke') {
    popupState.result = { action: popupState.result && popupState.result.action === 'skip' ? 'skip' : 'dismiss' };
  }

  if (popupState.closing || !popupState.windowHandle || !DestroyWindow) {
    return;
  }

  popupState.closing = true;
  DestroyWindow(popupState.windowHandle);
}

function pollForOutsideClick(popupState) {
  const mousePressed = isAnyMouseButtonPressed();
  const clickStartedOutside =
    mousePressed && !popupState.mousePressed && !isCursorInsideWindow(popupState.windowHandle);

  popupState.mousePressed = mousePressed;

  if (clickStartedOutside) {
    closePopup(popupState, 'dismiss');
  }
}

function isCursorInsideWindow(windowHandle) {
  if (!windowHandle || !GetCursorPos || !GetWindowRect) {
    return false;
  }

  const cursor = {};
  const rect = {};

  if (!GetCursorPos(cursor) || !GetWindowRect(windowHandle, rect)) {
    return false;
  }

  return (
    cursor.x >= rect.left &&
    cursor.x < rect.right &&
    cursor.y >= rect.top &&
    cursor.y < rect.bottom
  );
}

function isAnyMouseButtonPressed() {
  return (
    isMouseButtonPressed(VK_LBUTTON) ||
    isMouseButtonPressed(VK_RBUTTON) ||
    isMouseButtonPressed(VK_MBUTTON)
  );
}

function isMouseButtonPressed(virtualKey) {
  if (!GetAsyncKeyState) {
    return false;
  }

  return (Number(GetAsyncKeyState(virtualKey)) & 0x8000) !== 0;
}

function waitForPayload() {
  if (typeof process.send === 'function') {
    return new Promise((resolve) => {
      process.once('message', (payload) => {
        resolve(payload || {});
      });
    });
  }

  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(input.trim() ? JSON.parse(input) : {});
      } catch (error) {
        resolve({
          label: 'Send to Codex',
          shortcutLabel: '',
          error: error && error.message ? error.message : String(error)
        });
      }
    });
  });
}

async function main() {
  const payload = await waitForPayload();
  const result = showPopupAction(payload);

  if (typeof process.send === 'function') {
    process.send(result);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    const result = {
      action: 'error',
      message: error && error.message ? error.message : String(error)
    };

    if (typeof process.send === 'function') {
      process.send(result);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }

    process.exitCode = 1;
  });
}

module.exports = {
  showPopupAction
};

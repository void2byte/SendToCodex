'use strict';

const koffi = require('./vendor/koffi');

const WINDOW_WIDTH = 96;
const WINDOW_HEIGHT = 24;
const OUTER_MARGIN = 3;
const GAP_WIDTH = 2;
const CLOSE_BUTTON_WIDTH = 18;
const MAIN_BUTTON_WIDTH = WINDOW_WIDTH - CLOSE_BUTTON_WIDTH - GAP_WIDTH - OUTER_MARGIN * 2;
const BUTTON_HEIGHT = WINDOW_HEIGHT - OUTER_MARGIN * 2;
const WINDOW_RADIUS = 9;
const BUTTON_RADIUS = 6;
const ACTION_TARGET = 'action';
const CLOSE_TARGET = 'close';
const ACTION_RECT = {
  left: OUTER_MARGIN,
  top: OUTER_MARGIN,
  right: OUTER_MARGIN + MAIN_BUTTON_WIDTH,
  bottom: OUTER_MARGIN + BUTTON_HEIGHT
};
const CLOSE_RECT = {
  left: ACTION_RECT.right + GAP_WIDTH,
  top: OUTER_MARGIN,
  right: ACTION_RECT.right + GAP_WIDTH + CLOSE_BUTTON_WIDTH,
  bottom: OUTER_MARGIN + BUTTON_HEIGHT
};
const IDC_ARROW = 32512;

const WS_POPUP = 0x80000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_EX_TOPMOST = 0x00000008;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const SW_SHOWNOACTIVATE = 4;
const WM_ACTIVATE = 0x0006;
const WM_CLOSE = 0x0010;
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;
const WM_TIMER = 0x0113;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_CAPTURECHANGED = 0x0215;
const WA_INACTIVE = 0;
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const VK_MBUTTON = 0x04;
const CLICK_POLL_TIMER_ID = 1;
const CLICK_POLL_INTERVAL_MS = 40;
const DT_CENTER = 0x00000001;
const DT_VCENTER = 0x00000004;
const DT_SINGLELINE = 0x00000020;
const DT_NOPREFIX = 0x00000800;
const DT_END_ELLIPSIS = 0x00008000;
const TRANSPARENT_BK_MODE = 1;
const PS_SOLID = 0;
const FW_REGULAR = 400;
const FW_SEMIBOLD = 600;
const DEFAULT_CHARSET = 1;
const OUT_DEFAULT_PRECIS = 0;
const CLIP_DEFAULT_PRECIS = 0;
const CLEARTYPE_QUALITY = 5;
const DEFAULT_PITCH = 0;

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
const HWND = koffi.alias('HWND', HANDLE);
const HBRUSH = koffi.alias('HBRUSH', HANDLE);
const HCURSOR = koffi.alias('HCURSOR', HANDLE);
const HDC = koffi.alias('HDC', HANDLE);
const HFONT = koffi.alias('HFONT', HANDLE);
const HPEN = koffi.alias('HPEN', HANDLE);
const HRGN = koffi.alias('HRGN', HANDLE);
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
const gdi32 = process.platform === 'win32' ? koffi.load('gdi32.dll') : null;
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
const DrawTextW =
  user32 &&
  user32.func(
    'int __stdcall DrawTextW(HDC hdc, const char16_t *lpchText, int cchText, RECT *lprc, uint32_t format)'
  );
const GetAsyncKeyState = user32 && user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
const GetCursorPos = user32 && user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pos)');
const GetDC = user32 && user32.func('HDC __stdcall GetDC(HWND hWnd)');
const GetWindowRect =
  user32 && user32.func('bool __stdcall GetWindowRect(HWND hWnd, _Out_ RECT *lpRect)');
const GetMessageW =
  user32 &&
  user32.func(
    'int __stdcall GetMessageW(_Out_ MSG *lpMsg, HWND hWnd, uint32_t wMsgFilterMin, uint32_t wMsgFilterMax)'
  );
const InvalidateRect =
  user32 && user32.func('bool __stdcall InvalidateRect(HWND hWnd, const RECT *lpRect, bool bErase)');
const KillTimer = user32 && user32.func('bool __stdcall KillTimer(HWND hWnd, uintptr_t uIDEvent)');
const LoadCursorW =
  user32 && user32.func('HCURSOR __stdcall LoadCursorW(void *hInstance, uintptr_t lpCursorName)');
const PostQuitMessage = user32 && user32.func('void __stdcall PostQuitMessage(int nExitCode)');
const RegisterClassW =
  user32 && user32.func('uint16_t __stdcall RegisterClassW(const WNDCLASSW *lpWndClass)');
const ReleaseCapture = user32 && user32.func('bool __stdcall ReleaseCapture(void)');
const ReleaseDC = user32 && user32.func('int __stdcall ReleaseDC(HWND hWnd, HDC hDC)');
const SetCapture = user32 && user32.func('HWND __stdcall SetCapture(HWND hWnd)');
const SetTimer =
  user32 &&
  user32.func(
    'uintptr_t __stdcall SetTimer(HWND hWnd, uintptr_t nIDEvent, uint32_t uElapse, void *lpTimerFunc)'
  );
const SetWindowRgn =
  user32 && user32.func('int __stdcall SetWindowRgn(HWND hWnd, HRGN hRgn, bool bRedraw)');
const ShowWindow = user32 && user32.func('bool __stdcall ShowWindow(HWND hWnd, int nCmdShow)');
const TranslateMessage = user32 && user32.func('bool __stdcall TranslateMessage(const MSG *lpMsg)');
const UnregisterClassW =
  user32 &&
  user32.func('bool __stdcall UnregisterClassW(const char16_t *lpClassName, void *hInstance)');
const ValidateRect =
  user32 && user32.func('bool __stdcall ValidateRect(HWND hWnd, const RECT *lpRect)');
const CreateFontW =
  gdi32 &&
  gdi32.func(
    'HFONT __stdcall CreateFontW(int cHeight, int cWidth, int cEscapement, int cOrientation, int cWeight, uint32_t bItalic, uint32_t bUnderline, uint32_t bStrikeOut, uint32_t iCharSet, uint32_t iOutPrecision, uint32_t iClipPrecision, uint32_t iQuality, uint32_t iPitchAndFamily, const char16_t *pszFaceName)'
  );
const CreatePen =
  gdi32 && gdi32.func('HPEN __stdcall CreatePen(int iStyle, int cWidth, uint32_t color)');
const CreateRoundRectRgn =
  gdi32 &&
  gdi32.func('HRGN __stdcall CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)');
const CreateSolidBrush =
  gdi32 && gdi32.func('HBRUSH __stdcall CreateSolidBrush(uint32_t color)');
const DeleteObject = gdi32 && gdi32.func('bool __stdcall DeleteObject(HANDLE ho)');
const RoundRect =
  gdi32 &&
  gdi32.func(
    'bool __stdcall RoundRect(HDC hdc, int left, int top, int right, int bottom, int width, int height)'
  );
const SelectObject = gdi32 && gdi32.func('HANDLE __stdcall SelectObject(HDC hdc, HANDLE h)');
const SetBkMode = gdi32 && gdi32.func('int __stdcall SetBkMode(HDC hdc, int mode)');
const SetTextColor =
  gdi32 && gdi32.func('uint32_t __stdcall SetTextColor(HDC hdc, uint32_t color)');
const GetLastError = kernel32 && kernel32.func('uint32_t __stdcall GetLastError(void)');
const GetModuleHandleW =
  kernel32 &&
  kernel32.func('void * __stdcall GetModuleHandleW(const char16_t *lpModuleName)');

function buildActionLabel(payload) {
  return String((payload && payload.label) || 'Send to Codex').trim() || 'Send to Codex';
}

function buildDisplayActionLabel(payload) {
  const label = buildActionLabel(payload);
  return /^send to codex$/i.test(label) ? 'Codex' : label;
}

function createPalette(colors) {
  return Object.fromEntries(
    Object.entries(colors).map(([key, value]) => [key, hexToColorRef(value)])
  );
}

const THEME_PALETTES = {
  dark: createPalette({
    surface: '#252526',
    border: '#3c3c3c',
    action: '#0e639c',
    actionHover: '#1177bb',
    actionPressed: '#095484',
    actionBorder: '#2388c8',
    actionText: '#ffffff',
    close: '#252526',
    closeHover: '#34363a',
    closePressed: '#3f4248',
    closeText: '#cccccc'
  }),
  light: createPalette({
    surface: '#f3f3f3',
    border: '#c8c8c8',
    action: '#007acc',
    actionHover: '#006bb3',
    actionPressed: '#005a9e',
    actionBorder: '#007acc',
    actionText: '#ffffff',
    close: '#f3f3f3',
    closeHover: '#e5e5e5',
    closePressed: '#d6d6d6',
    closeText: '#616161'
  }),
  highContrast: createPalette({
    surface: '#000000',
    border: '#f38518',
    action: '#000000',
    actionHover: '#1a1a1a',
    actionPressed: '#333333',
    actionBorder: '#f38518',
    actionText: '#ffffff',
    close: '#000000',
    closeHover: '#1a1a1a',
    closePressed: '#333333',
    closeText: '#ffffff'
  }),
  highContrastLight: createPalette({
    surface: '#ffffff',
    border: '#0f4a85',
    action: '#ffffff',
    actionHover: '#e8f2ff',
    actionPressed: '#d8e9ff',
    actionBorder: '#0f4a85',
    actionText: '#000000',
    close: '#ffffff',
    closeHover: '#eeeeee',
    closePressed: '#dddddd',
    closeText: '#000000'
  })
};

function resolveThemePalette(payload) {
  const themeKind = String((payload && payload.themeKind) || '').trim();
  return THEME_PALETTES[themeKind] || THEME_PALETTES.dark;
}

function hexToColorRef(hex) {
  const value = Number.parseInt(String(hex).replace(/^#/, ''), 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return red | (green << 8) | (blue << 16);
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
    actionLabel: buildDisplayActionLabel(payload),
    closing: false,
    hoverTarget: null,
    mousePressed: false,
    palette: resolveThemePalette(payload),
    pressedTarget: null,
    result: { action: 'dismiss' },
    windowHandle: null
  };

  const windowProc = koffi.register((hWnd, message, wParam, lParam) => {
    switch (message) {
      case WM_ACTIVATE:
        if ((Number(wParam) & 0xffff) === WA_INACTIVE) {
          closePopup(popupState, 'dismiss');
          return 0;
        }
        break;
      case WM_CLOSE:
        closePopup(popupState, 'dismiss');
        return 0;
      case WM_ERASEBKGND:
        return 1;
      case WM_PAINT:
        paintPopup(popupState);
        return 0;
      case WM_MOUSEMOVE:
        handleMouseMove(popupState, lParam);
        return 0;
      case WM_LBUTTONDOWN:
        handleMouseDown(popupState, lParam);
        return 0;
      case WM_LBUTTONUP:
        handleMouseUp(popupState, lParam);
        return 0;
      case WM_CAPTURECHANGED:
        clearPressedTarget(popupState);
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
      hCursor: LoadCursorW ? LoadCursorW(null, IDC_ARROW) : null,
      hbrBackground: null,
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
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
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
    applyRoundedWindowRegion(windowHandle);

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
    paintPopup(popupState);

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

function applyRoundedWindowRegion(windowHandle) {
  if (!windowHandle || !CreateRoundRectRgn || !SetWindowRgn) {
    return;
  }

  const region = CreateRoundRectRgn(0, 0, WINDOW_WIDTH + 1, WINDOW_HEIGHT + 1, WINDOW_RADIUS, WINDOW_RADIUS);
  if (!region) {
    return;
  }

  if (!SetWindowRgn(windowHandle, region, true) && DeleteObject) {
    DeleteObject(region);
  }
}

function paintPopup(popupState) {
  if (!popupState.windowHandle || !GetDC) {
    return;
  }

  const deviceContext = GetDC(popupState.windowHandle);
  if (!deviceContext) {
    return;
  }

  try {
    drawPopup(deviceContext, popupState);
  } finally {
    if (ReleaseDC) {
      ReleaseDC(popupState.windowHandle, deviceContext);
    }
    if (ValidateRect) {
      ValidateRect(popupState.windowHandle, null);
    }
  }
}

function drawPopup(deviceContext, popupState) {
  const palette = popupState.palette || THEME_PALETTES.dark;
  const surfaceRect = {
    left: 0,
    top: 0,
    right: WINDOW_WIDTH,
    bottom: WINDOW_HEIGHT
  };

  drawRoundedRect(deviceContext, surfaceRect, palette.surface, palette.border, WINDOW_RADIUS);
  drawRoundedRect(
    deviceContext,
    ACTION_RECT,
    getTargetColor(palette, popupState, ACTION_TARGET),
    palette.actionBorder,
    BUTTON_RADIUS
  );
  drawCenteredText(
    deviceContext,
    popupState.actionLabel,
    insetRect(ACTION_RECT, 2, 0),
    palette.actionText,
    -11,
    FW_SEMIBOLD
  );

  drawRoundedRect(
    deviceContext,
    CLOSE_RECT,
    getTargetColor(palette, popupState, CLOSE_TARGET),
    popupState.hoverTarget === CLOSE_TARGET || popupState.pressedTarget === CLOSE_TARGET
      ? palette.border
      : getTargetColor(palette, popupState, CLOSE_TARGET),
    BUTTON_RADIUS
  );
  drawCenteredText(deviceContext, '\u00D7', CLOSE_RECT, palette.closeText, -12, FW_REGULAR);
}

function drawRoundedRect(deviceContext, rect, fillColor, borderColor, radius) {
  if (!CreateSolidBrush || !CreatePen || !RoundRect || !SelectObject) {
    return;
  }

  const brush = CreateSolidBrush(fillColor);
  const pen = CreatePen(PS_SOLID, 1, borderColor);
  const oldBrush = brush ? SelectObject(deviceContext, brush) : null;
  const oldPen = pen ? SelectObject(deviceContext, pen) : null;

  RoundRect(
    deviceContext,
    rect.left,
    rect.top,
    rect.right,
    rect.bottom,
    radius,
    radius
  );

  if (oldPen) {
    SelectObject(deviceContext, oldPen);
  }
  if (oldBrush) {
    SelectObject(deviceContext, oldBrush);
  }
  if (pen && DeleteObject) {
    DeleteObject(pen);
  }
  if (brush && DeleteObject) {
    DeleteObject(brush);
  }
}

function drawCenteredText(deviceContext, text, rect, color, fontHeight, fontWeight) {
  if (!DrawTextW) {
    return;
  }

  const font = CreateFontW
    ? CreateFontW(
        fontHeight,
        0,
        0,
        0,
        fontWeight,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        DEFAULT_PITCH,
        'Segoe UI'
      )
    : null;
  const oldFont = font && SelectObject ? SelectObject(deviceContext, font) : null;
  const textRect = cloneRect(rect);

  if (SetBkMode) {
    SetBkMode(deviceContext, TRANSPARENT_BK_MODE);
  }
  if (SetTextColor) {
    SetTextColor(deviceContext, color);
  }

  DrawTextW(
    deviceContext,
    String(text || ''),
    -1,
    textRect,
    DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX
  );

  if (oldFont && SelectObject) {
    SelectObject(deviceContext, oldFont);
  }
  if (font && DeleteObject) {
    DeleteObject(font);
  }
}

function getTargetColor(palette, popupState, target) {
  const prefix = target === ACTION_TARGET ? 'action' : 'close';

  if (popupState.pressedTarget === target) {
    return palette[`${prefix}Pressed`];
  }
  if (popupState.hoverTarget === target) {
    return palette[`${prefix}Hover`];
  }

  return palette[prefix];
}

function handleMouseMove(popupState, lParam) {
  updateHoverTarget(popupState, hitTestPoint(readMousePoint(lParam)));
}

function handleMouseDown(popupState, lParam) {
  const target = hitTestPoint(readMousePoint(lParam));
  updateHoverTarget(popupState, target);
  popupState.pressedTarget = target;

  if (target && SetCapture && popupState.windowHandle) {
    SetCapture(popupState.windowHandle);
  }

  redrawPopup(popupState);
}

function handleMouseUp(popupState, lParam) {
  const target = hitTestPoint(readMousePoint(lParam));
  const pressedTarget = popupState.pressedTarget;
  popupState.pressedTarget = null;

  if (ReleaseCapture) {
    ReleaseCapture();
  }

  updateHoverTarget(popupState, target);
  redrawPopup(popupState);

  if (target && target === pressedTarget) {
    closePopup(popupState, target === ACTION_TARGET ? 'invoke' : 'skip');
  }
}

function clearPressedTarget(popupState) {
  if (!popupState.pressedTarget) {
    return;
  }

  popupState.pressedTarget = null;
  redrawPopup(popupState);
}

function updateHoverTarget(popupState, nextTarget) {
  if (popupState.hoverTarget === nextTarget) {
    return;
  }

  popupState.hoverTarget = nextTarget;
  redrawPopup(popupState);
}

function redrawPopup(popupState) {
  if (!popupState.windowHandle) {
    return;
  }

  if (InvalidateRect) {
    InvalidateRect(popupState.windowHandle, null, false);
    return;
  }

  paintPopup(popupState);
}

function hitTestPoint(point) {
  if (isPointInRect(point, ACTION_RECT)) {
    return ACTION_TARGET;
  }
  if (isPointInRect(point, CLOSE_RECT)) {
    return CLOSE_TARGET;
  }
  return null;
}

function isPointInRect(point, rect) {
  return (
    point &&
    point.x >= rect.left &&
    point.x < rect.right &&
    point.y >= rect.top &&
    point.y < rect.bottom
  );
}

function readMousePoint(lParam) {
  const value = Number(lParam);
  let x = value & 0xffff;
  let y = (value >> 16) & 0xffff;

  if (x >= 0x8000) {
    x -= 0x10000;
  }
  if (y >= 0x8000) {
    y -= 0x10000;
  }

  return { x, y };
}

function insetRect(rect, horizontal, vertical) {
  return {
    left: rect.left + horizontal,
    top: rect.top + vertical,
    right: rect.right - horizontal,
    bottom: rect.bottom - vertical
  };
}

function cloneRect(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom
  };
}

function pollForOutsideClick(popupState) {
  const mousePressed = isAnyMouseButtonPressed();
  const cursorPoint = getCursorWindowPoint(popupState.windowHandle);
  const clickStartedOutside =
    mousePressed && !popupState.mousePressed && (!cursorPoint || !cursorPoint.inside);

  updateHoverTarget(
    popupState,
    cursorPoint && cursorPoint.inside ? hitTestPoint(cursorPoint) : null
  );

  popupState.mousePressed = mousePressed;

  if (clickStartedOutside) {
    closePopup(popupState, 'dismiss');
  }
}

function getCursorWindowPoint(windowHandle) {
  if (!windowHandle || !GetCursorPos || !GetWindowRect) {
    return null;
  }

  const cursor = {};
  const rect = {};

  if (!GetCursorPos(cursor) || !GetWindowRect(windowHandle, rect)) {
    return null;
  }

  const x = cursor.x - rect.left;
  const y = cursor.y - rect.top;
  return {
    inside: x >= 0 && x < rect.right - rect.left && y >= 0 && y < rect.bottom - rect.top,
    x,
    y
  };
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

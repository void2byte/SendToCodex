#!/usr/bin/env python3

import json
import sys

try:
    import tkinter as tk
except Exception as error:
    print(json.dumps({"action": "error", "message": str(error)}), flush=True)
    sys.exit(1)


WINDOW_WIDTH = 96
WINDOW_HEIGHT = 24
OUTER_MARGIN = 3
GAP_WIDTH = 2
CLOSE_BUTTON_WIDTH = 18
MAIN_BUTTON_WIDTH = WINDOW_WIDTH - CLOSE_BUTTON_WIDTH - GAP_WIDTH - OUTER_MARGIN * 2
BUTTON_HEIGHT = WINDOW_HEIGHT - OUTER_MARGIN * 2
ACTION_RECT = (
    OUTER_MARGIN,
    OUTER_MARGIN,
    OUTER_MARGIN + MAIN_BUTTON_WIDTH,
    OUTER_MARGIN + BUTTON_HEIGHT,
)
CLOSE_RECT = (
    ACTION_RECT[2] + GAP_WIDTH,
    OUTER_MARGIN,
    ACTION_RECT[2] + GAP_WIDTH + CLOSE_BUTTON_WIDTH,
    OUTER_MARGIN + BUTTON_HEIGHT,
)

THEME_PALETTES = {
    "dark": {
        "surface": "#252526",
        "border": "#3c3c3c",
        "action": "#0e639c",
        "actionHover": "#1177bb",
        "actionPressed": "#095484",
        "actionBorder": "#2388c8",
        "actionText": "#ffffff",
        "close": "#252526",
        "closeHover": "#34363a",
        "closePressed": "#3f4248",
        "closeText": "#cccccc",
    },
    "light": {
        "surface": "#f3f3f3",
        "border": "#c8c8c8",
        "action": "#007acc",
        "actionHover": "#006bb3",
        "actionPressed": "#005a9e",
        "actionBorder": "#007acc",
        "actionText": "#ffffff",
        "close": "#f3f3f3",
        "closeHover": "#e5e5e5",
        "closePressed": "#d6d6d6",
        "closeText": "#616161",
    },
    "highContrast": {
        "surface": "#000000",
        "border": "#f38518",
        "action": "#000000",
        "actionHover": "#1a1a1a",
        "actionPressed": "#333333",
        "actionBorder": "#f38518",
        "actionText": "#ffffff",
        "close": "#000000",
        "closeHover": "#1a1a1a",
        "closePressed": "#333333",
        "closeText": "#ffffff",
    },
    "highContrastLight": {
        "surface": "#ffffff",
        "border": "#0f4a85",
        "action": "#ffffff",
        "actionHover": "#e8f2ff",
        "actionPressed": "#d8e9ff",
        "actionBorder": "#0f4a85",
        "actionText": "#000000",
        "close": "#ffffff",
        "closeHover": "#eeeeee",
        "closePressed": "#dddddd",
        "closeText": "#000000",
    },
}


def read_payload():
    raw = sys.stdin.read()
    if not raw.strip():
        return {}

    try:
        return json.loads(raw)
    except Exception as error:
        return {"label": "Send to Codex", "error": str(error)}


def display_label(payload):
    label = str(payload.get("label") or "Send to Codex").strip() or "Send to Codex"
    return "Codex" if label.lower() == "send to codex" else label


def palette_for(payload):
    return THEME_PALETTES.get(str(payload.get("themeKind") or ""), THEME_PALETTES["dark"])


def point_in_rect(x, y, rect):
    return rect[0] <= x < rect[2] and rect[1] <= y < rect[3]


def hit_test(x, y):
    if point_in_rect(x, y, ACTION_RECT):
        return "action"
    if point_in_rect(x, y, CLOSE_RECT):
        return "close"
    return None


def rounded_rect(canvas, rect, radius, fill, outline):
    x1, y1, x2, y2 = rect
    points = [
        x1 + radius,
        y1,
        x2 - radius,
        y1,
        x2,
        y1,
        x2,
        y1 + radius,
        x2,
        y2 - radius,
        x2,
        y2,
        x2 - radius,
        y2,
        x1 + radius,
        y2,
        x1,
        y2,
        x1,
        y2 - radius,
        x1,
        y1 + radius,
        x1,
        y1,
    ]
    canvas.create_polygon(points, smooth=True, fill=fill, outline=outline)


def run_popup(payload):
    palette = palette_for(payload)
    state = {"hover": None, "pressed": None, "done": False}
    root = tk.Tk()
    root.withdraw()
    root.overrideredirect(True)

    try:
        root.attributes("-topmost", True)
    except tk.TclError:
        pass

    try:
        root.attributes("-type", "toolbar")
    except tk.TclError:
        pass

    canvas = tk.Canvas(
        root,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        highlightthickness=0,
        bd=0,
        bg=palette["surface"],
    )
    canvas.pack(fill="both", expand=True)

    label = display_label(payload)

    def target_color(target):
        prefix = "action" if target == "action" else "close"
        if state["pressed"] == target:
            return palette[prefix + "Pressed"]
        if state["hover"] == target:
            return palette[prefix + "Hover"]
        return palette[prefix]

    def redraw():
        canvas.delete("all")
        rounded_rect(
            canvas,
            (0, 0, WINDOW_WIDTH, WINDOW_HEIGHT),
            9,
            palette["surface"],
            palette["border"],
        )
        rounded_rect(
            canvas,
            ACTION_RECT,
            6,
            target_color("action"),
            palette["actionBorder"],
        )
        canvas.create_text(
            (ACTION_RECT[0] + ACTION_RECT[2]) // 2,
            (ACTION_RECT[1] + ACTION_RECT[3]) // 2,
            text=label,
            fill=palette["actionText"],
            font=("Sans", 8, "bold"),
        )
        close_border = (
            palette["border"]
            if state["hover"] == "close" or state["pressed"] == "close"
            else target_color("close")
        )
        rounded_rect(canvas, CLOSE_RECT, 6, target_color("close"), close_border)
        canvas.create_text(
            (CLOSE_RECT[0] + CLOSE_RECT[2]) // 2,
            (CLOSE_RECT[1] + CLOSE_RECT[3]) // 2 - 1,
            text="x",
            fill=palette["closeText"],
            font=("Sans", 8),
        )

    def emit(action):
        if state["done"]:
            return

        state["done"] = True
        print(json.dumps({"action": action}), flush=True)
        try:
            root.destroy()
        except tk.TclError:
            pass

    def on_motion(event):
        next_hover = hit_test(event.x, event.y)
        if next_hover != state["hover"]:
            state["hover"] = next_hover
            redraw()

    def on_leave(_event):
        if state["hover"] is not None:
            state["hover"] = None
            redraw()

    def on_press(event):
        state["pressed"] = hit_test(event.x, event.y)
        redraw()

    def on_release(event):
        target = hit_test(event.x, event.y)
        pressed = state["pressed"]
        state["pressed"] = None
        redraw()

        if target and target == pressed:
            emit("invoke" if target == "action" else "skip")

    canvas.bind("<Motion>", on_motion)
    canvas.bind("<Leave>", on_leave)
    canvas.bind("<ButtonPress-1>", on_press)
    canvas.bind("<ButtonRelease-1>", on_release)
    root.bind("<Escape>", lambda _event: emit("dismiss"))
    root.protocol("WM_DELETE_WINDOW", lambda: emit("dismiss"))

    pointer_x = root.winfo_pointerx()
    pointer_y = root.winfo_pointery()
    offset_x = int(payload.get("offsetX") or 12)
    offset_y = int(payload.get("offsetY") or 18)
    x = pointer_x + offset_x
    y = pointer_y + offset_y
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = max(0, min(x, max(0, screen_width - WINDOW_WIDTH)))
    y = max(0, min(y, max(0, screen_height - WINDOW_HEIGHT)))

    root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}+{x}+{y}")
    redraw()
    root.deiconify()
    root.lift()
    root.after(12000, lambda: emit("dismiss"))
    root.mainloop()


def main():
    payload = read_payload()
    try:
        run_popup(payload)
    except Exception as error:
        print(json.dumps({"action": "error", "message": str(error)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()

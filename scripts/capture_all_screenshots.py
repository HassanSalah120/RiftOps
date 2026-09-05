"""Capture high-resolution showcase screenshots from running RiftOps desktop app.

Attaches to the interactive default desktop in WinSta0, cycles through all major
features, captures clean 1280x800 PNG images, and saves to assets/screenshots.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import sys
import time
from pathlib import Path

import win32api
import win32con
from PIL import Image, ImageGrab

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS_DIR = ROOT / "assets" / "screenshots"

TABS = {
    "dashboard": 200,
    "play": 250,
    "live": 295,
    "social": 343,
    "history": 410,
    "skins": 458,
    "loot": 503,
    "qol": 570,
    "remote": 615,
    "settings": 665,
}

def setup_desktop():
    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()

    h_desk = user32.OpenDesktopW("default", 0, False, 0x01FF)
    if not h_desk:
        raise RuntimeError("Could not open default desktop")
    user32.SetThreadDesktop(h_desk)

    hwnd = user32.FindWindowW(None, "RiftOps")
    if not hwnd:
        raise RuntimeError("RiftOps window was not found on default desktop")

    user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.5)

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return hwnd, (rect.left, rect.top, rect.right, rect.bottom)

def scroll_sidebar_top(hwnd, left, top):
    win32api.SetCursorPos((left + 120, top + 135))
    win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, 120 * 20, 0)
    time.sleep(0.15)

def click_tab(hwnd, left, top, tab_y):
    scroll_sidebar_top(hwnd, left, top)
    win32api.SetCursorPos((left + 115, top + tab_y))
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(1.4)

def click_content(left, top, x, y):
    win32api.SetCursorPos((left + x, top + y))
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(1.4)

def page_down():
    win32api.keybd_event(win32con.VK_NEXT, 0, 0, 0)
    win32api.keybd_event(win32con.VK_NEXT, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.8)

def page_up():
    win32api.keybd_event(win32con.VK_PRIOR, 0, 0, 0)
    win32api.keybd_event(win32con.VK_PRIOR, 0, win32con.KEYEVENTF_KEYUP, 0)
    time.sleep(0.8)

def capture_bounds(bounds, dest):
    img = ImageGrab.grab(bbox=bounds)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, format="PNG", optimize=True)
    print(f"Captured: {dest.name} ({img.size[0]}x{img.size[1]})")
    return img

def main():
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    hwnd, bounds = setup_desktop()
    left, top, right, bottom = bounds

    # 1. Command Center
    click_tab(hwnd, left, top, TABS["dashboard"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "command-center.png")

    # 2. Skin Collection (top grid)
    click_tab(hwnd, left, top, TABS["skins"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "skins-vault.png")

    # 3. Skin Collection (scrolled detail showing tiers and shards)
    page_down()
    capture_bounds(bounds, SCREENSHOTS_DIR / "skins-vault-detail.png")
    page_up()

    # 4. Profile Studio (click tab in Collection)
    click_content(left, top, 800, 120)
    capture_bounds(bounds, SCREENSHOTS_DIR / "profile-studio.png")

    # 5. Loot Workshop
    click_tab(hwnd, left, top, TABS["loot"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "loot-workshop.png")

    # 6. Live Session
    click_tab(hwnd, left, top, TABS["live"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "live-session.png")

    # 7. Quality of Life Cockpit
    click_tab(hwnd, left, top, TABS["qol"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "qol-cockpit.png")

    # 8. Match History
    click_tab(hwnd, left, top, TABS["history"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "match-history.png")

    # 9. Settings Cockpit
    click_tab(hwnd, left, top, TABS["settings"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "settings-cockpit.png")

    # 10. Play Flow
    click_tab(hwnd, left, top, TABS["play"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "play-flow.png")

    # 11. Social Center
    click_tab(hwnd, left, top, TABS["social"])
    capture_bounds(bounds, SCREENSHOTS_DIR / "social-center.png")

    print("\nAll 11 showcase screenshots successfully captured into:", SCREENSHOTS_DIR)
    return 0

if __name__ == "__main__":
    sys.exit(main())

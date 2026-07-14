/// <reference lib="deno.worker" />
// System-tray worker. Owns a hidden Win32 window + message pump on this
// dedicated thread (the main thread is blocked inside webview.run(), and the
// server worker must never block). All interaction with the webview window
// uses cross-thread-safe HWND calls (ShowWindow/IsIconic/PostMessage).
//
// Behavior (owner-specified):
//  - app minimize → window hidden to tray (poll IsIconic, 250ms timer)
//  - tray icon always present while the app runs (Docker-Desktop convention)
//  - right-click menu: Open app | Stop WSL | Restart WSL | Quit app
//  - double-click tray icon → Open app
//  - webview window destroyed (title-bar X) → icon removed, worker ends

import { exec } from "../adapter/exec.ts";

// ---------- Win32 constants ----------
const WM_NULL = 0x0000;
const WM_CLOSE = 0x0010;
const WM_SETICON = 0x0080;
const WM_TIMER = 0x0113;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_RBUTTONUP = 0x0205;
const WM_CONTEXTMENU = 0x007B;
const WM_APP_TRAY = 0x8001;
const SW_HIDE = 0;
const SW_SHOW = 5;
const SW_RESTORE = 9;
const NIM_ADD = 0;
const NIM_DELETE = 2;
const NIF_MESSAGE = 1;
const NIF_ICON = 2;
const NIF_TIP = 4;
const MF_STRING = 0x0000;
const MF_SEPARATOR = 0x0800;
const TPM_RIGHTBUTTON = 0x0002;
const TPM_NONOTIFY = 0x0080;
const TPM_RETURNCMD = 0x0100;
const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x0010;
const ICON_SMALL = 0;
const ICON_BIG = 1;
const CMD_OPEN = 101;
const CMD_QUIT = 102;
const CMD_STOP_WSL = 103;
const CMD_RESTART_WSL = 104;

const user32 = Deno.dlopen("user32.dll", {
  RegisterClassExW: { parameters: ["buffer"], result: "u16" },
  CreateWindowExW: {
    parameters: ["u32", "buffer", "buffer", "u32", "i32", "i32", "i32", "i32", "pointer", "pointer", "pointer", "pointer"],
    result: "pointer",
  },
  DefWindowProcW: { parameters: ["pointer", "u32", "usize", "isize"], result: "isize" },
  GetMessageW: { parameters: ["buffer", "pointer", "u32", "u32"], result: "i32" },
  TranslateMessage: { parameters: ["buffer"], result: "i32" },
  DispatchMessageW: { parameters: ["buffer"], result: "isize" },
  CreatePopupMenu: { parameters: [], result: "pointer" },
  AppendMenuW: { parameters: ["pointer", "u32", "usize", "buffer"], result: "i32" },
  TrackPopupMenu: { parameters: ["pointer", "u32", "i32", "i32", "i32", "pointer", "pointer"], result: "i32" },
  GetCursorPos: { parameters: ["buffer"], result: "i32" },
  SetForegroundWindow: { parameters: ["pointer"], result: "i32" },
  ShowWindow: { parameters: ["pointer", "i32"], result: "i32" },
  IsIconic: { parameters: ["pointer"], result: "i32" },
  IsWindow: { parameters: ["pointer"], result: "i32" },
  PostMessageW: { parameters: ["pointer", "u32", "usize", "isize"], result: "i32" },
  SendMessageW: { parameters: ["pointer", "u32", "usize", "isize"], result: "isize" },
  SetTimer: { parameters: ["pointer", "usize", "u32", "pointer"], result: "usize" },
  LoadImageW: { parameters: ["pointer", "buffer", "u32", "i32", "i32", "u32"], result: "pointer" },
  DestroyWindow: { parameters: ["pointer"], result: "i32" },
  DestroyMenu: { parameters: ["pointer"], result: "i32" },
  DestroyIcon: { parameters: ["pointer"], result: "i32" },
});
const shell32 = Deno.dlopen("shell32.dll", {
  Shell_NotifyIconW: { parameters: ["u32", "buffer"], result: "i32" },
});
const kernel32 = Deno.dlopen("kernel32.dll", {
  GetModuleHandleW: { parameters: ["pointer"], result: "pointer" },
});

/** UTF-16LE NUL-terminated string buffer. */
function wide(s: string): Uint8Array {
  const buf = new Uint8Array((s.length + 1) * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return buf;
}

function ptrOf(buf: Uint8Array): Deno.PointerValue {
  return Deno.UnsafePointer.of(buf);
}

function ptrToBig(p: Deno.PointerValue): bigint {
  return p === null ? 0n : BigInt(Deno.UnsafePointer.value(p));
}

function bigToPtr(v: bigint): Deno.PointerValue {
  return Deno.UnsafePointer.create(v);
}

type TrayAction = "menu" | "open" | "poll";
const queue: TrayAction[] = [];

let webviewHwnd: Deno.PointerValue = null;
let trayHwnd: Deno.PointerValue = null;
let menu: Deno.PointerValue = null;
let trayIcon: Deno.PointerValue = null; // i11: freed on teardown
let nid: Uint8Array | null = null;
let running = true;

// Keep alive for the process lifetime (GC of these = crash).
const keepAlive: unknown[] = [];

const wndProc = new Deno.UnsafeCallback(
  { parameters: ["pointer", "u32", "usize", "isize"], result: "isize" },
  (hwnd, msg, wParam, lParam) => {
    if (msg === WM_APP_TRAY) {
      const mouse = Number(BigInt(lParam) & 0xffffn);
      if (mouse === WM_RBUTTONUP || mouse === WM_CONTEXTMENU) queue.push("menu");
      else if (mouse === WM_LBUTTONDBLCLK) queue.push("open");
      return 0n;
    }
    if (msg === WM_TIMER) {
      queue.push("poll");
      return 0n;
    }
    return user32.symbols.DefWindowProcW(hwnd, msg, wParam, lParam);
  },
);
keepAlive.push(wndProc);

function createTray(iconPath: string | null): void {
  const hInst = kernel32.symbols.GetModuleHandleW(null);
  const className = wide("wslcGuiTrayClass");
  keepAlive.push(className);

  // WNDCLASSEXW (x64: 80 bytes)
  const wc = new Uint8Array(80);
  const wcv = new DataView(wc.buffer);
  wcv.setUint32(0, 80, true); // cbSize
  wcv.setBigUint64(8, ptrToBig(wndProc.pointer), true); // lpfnWndProc
  wcv.setBigUint64(24, ptrToBig(hInst), true); // hInstance
  wcv.setBigUint64(64, ptrToBig(ptrOf(className)), true); // lpszClassName
  if (user32.symbols.RegisterClassExW(wc) === 0) throw new Error("RegisterClassExW failed");

  const title = wide("wslc-gui-tray");
  keepAlive.push(title);
  trayHwnd = user32.symbols.CreateWindowExW(0, className, title, 0, 0, 0, 0, 0, null, null, hInst, null);
  if (trayHwnd === null) throw new Error("CreateWindowExW failed");

  // Icon: shipped .ico from disk; falls back to no icon (tray still functional).
  let hIcon: Deno.PointerValue = null;
  if (iconPath) {
    const p = wide(iconPath);
    hIcon = user32.symbols.LoadImageW(null, p, IMAGE_ICON, 0, 0, LR_LOADFROMFILE);
  }
  trayIcon = hIcon; // i11: retain for DestroyIcon on teardown

  // Window/taskbar icon for the webview window too.
  if (hIcon !== null && webviewHwnd !== null) {
    const iconBig = BigInt(Deno.UnsafePointer.value(hIcon));
    user32.symbols.SendMessageW(webviewHwnd, WM_SETICON, BigInt(ICON_SMALL), iconBig);
    user32.symbols.SendMessageW(webviewHwnd, WM_SETICON, BigInt(ICON_BIG), iconBig);
  }

  // NOTIFYICONDATAW (x64: 976 bytes)
  nid = new Uint8Array(976);
  const nv = new DataView(nid.buffer);
  nv.setUint32(0, 976, true); // cbSize
  nv.setBigUint64(8, ptrToBig(trayHwnd), true); // hWnd
  nv.setUint32(16, 1, true); // uID
  nv.setUint32(20, NIF_MESSAGE | NIF_TIP | (hIcon !== null ? NIF_ICON : 0), true); // uFlags
  nv.setUint32(24, WM_APP_TRAY, true); // uCallbackMessage
  nv.setBigUint64(32, ptrToBig(hIcon), true); // hIcon
  const tip = "WSL Container Manager";
  for (let i = 0; i < tip.length; i++) nv.setUint16(40 + i * 2, tip.charCodeAt(i), true); // szTip
  if (shell32.symbols.Shell_NotifyIconW(NIM_ADD, nid) === 0) throw new Error("Shell_NotifyIconW failed");

  // Context menu (owner-specified labels).
  menu = user32.symbols.CreatePopupMenu();
  const items: [number, string][] = [
    [CMD_OPEN, "Open app"],
    [CMD_STOP_WSL, "Stop WSL"],
    [CMD_RESTART_WSL, "Restart WSL"],
    [CMD_QUIT, "Quit app"],
  ];
  for (const [id, label] of items) {
    if (id === CMD_QUIT) user32.symbols.AppendMenuW(menu, MF_SEPARATOR, 0n, null as unknown as Uint8Array);
    const l = wide(label);
    keepAlive.push(l);
    user32.symbols.AppendMenuW(menu, MF_STRING, BigInt(id), l);
  }

  // Minimize-to-tray + liveness polling.
  user32.symbols.SetTimer(trayHwnd, 1n, 250, null);
}

function removeTray(): void {
  if (nid) shell32.symbols.Shell_NotifyIconW(NIM_DELETE, nid);
  nid = null;
}

function openApp(): void {
  if (webviewHwnd === null) return;
  user32.symbols.ShowWindow(webviewHwnd, SW_SHOW);
  user32.symbols.ShowWindow(webviewHwnd, SW_RESTORE);
  user32.symbols.SetForegroundWindow(webviewHwnd);
}

async function handleAction(action: TrayAction): Promise<void> {
  if (action === "poll") {
    if (webviewHwnd !== null && user32.symbols.IsWindow(webviewHwnd) === 0) {
      // Window gone (user closed via X): clean the icon up and end.
      removeTray();
      running = false;
      return;
    }
    if (webviewHwnd !== null && user32.symbols.IsIconic(webviewHwnd) !== 0) {
      user32.symbols.ShowWindow(webviewHwnd, SW_HIDE); // minimize → tray
    }
    return;
  }
  if (action === "open") {
    openApp();
    return;
  }
  // action === "menu"
  const pt = new Uint8Array(8);
  user32.symbols.GetCursorPos(pt);
  const pv = new DataView(pt.buffer);
  user32.symbols.SetForegroundWindow(trayHwnd);
  const cmd = user32.symbols.TrackPopupMenu(
    menu,
    TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
    pv.getInt32(0, true),
    pv.getInt32(4, true),
    0,
    trayHwnd,
    null,
  );
  user32.symbols.PostMessageW(trayHwnd, WM_NULL, 0n, 0n);
  switch (cmd) {
    case CMD_OPEN:
      openApp();
      break;
    case CMD_QUIT:
      removeTray();
      if (webviewHwnd !== null) user32.symbols.PostMessageW(webviewHwnd, WM_CLOSE, 0n, 0n);
      running = false;
      break;
    case CMD_STOP_WSL:
      await exec("wsl", ["--shutdown"], { timeoutMs: 60_000 });
      break;
    case CMD_RESTART_WSL:
      await exec("wsl", ["--shutdown"], { timeoutMs: 60_000 });
      // Booting the default distro for a no-op brings the VM back up.
      await exec("wsl", ["-e", "true"], { timeoutMs: 120_000 });
      break;
  }
}

async function pump(): Promise<void> {
  const msg = new Uint8Array(48); // MSG (x64)
  while (running) {
    const r = user32.symbols.GetMessageW(msg, null, 0, 0);
    if (r <= 0) break;
    user32.symbols.TranslateMessage(msg);
    user32.symbols.DispatchMessageW(msg);
    while (queue.length > 0) {
      await handleAction(queue.shift()!);
    }
  }
  removeTray();
  // i11: free the GDI/menu handles we own (hygiene — process teardown would reclaim them,
  // but leaking named resources is exactly what the review flagged).
  if (menu !== null) {
    user32.symbols.DestroyMenu(menu);
    menu = null;
  }
  if (trayIcon !== null) {
    user32.symbols.DestroyIcon(trayIcon);
    trayIcon = null;
  }
  if (trayHwnd !== null) user32.symbols.DestroyWindow(trayHwnd);
  self.close();
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.type === "init") {
    try {
      webviewHwnd = bigToPtr(BigInt(m.hwnd));
      createTray(typeof m.iconPath === "string" ? m.iconPath : null);
      (self as unknown as Worker).postMessage({ type: "ready" });
      void pump();
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: "error", message: String(err) });
      self.close();
    }
  }
};

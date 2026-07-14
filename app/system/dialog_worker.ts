/// <reference lib="deno.worker" />
// Native Windows file/folder dialogs. Runs in a transient worker per request:
// these dialogs pump their own modal message loop and BLOCK the calling
// thread — never the server worker, never main.
//
// Security: the dialog only RETURNS a path string to the UI; every consumer
// endpoint still validates it server-side (winPath etc.) before any use.

const OFN_EXPLORER = 0x00080000;
const OFN_NOCHANGEDIR = 0x00000008;
const OFN_OVERWRITEPROMPT = 0x00000002;
const OFN_PATHMUSTEXIST = 0x00000800;
const BIF_RETURNONLYFSDIRS = 0x0001;
const BIF_NEWDIALOGSTYLE = 0x0040;
const COINIT_APARTMENTTHREADED = 0x2;
const MAX_PATH_BUF = 32768;

const GPFIDL_DEFAULT = 0;

const comdlg32 = Deno.dlopen("comdlg32.dll", {
  GetOpenFileNameW: { parameters: ["buffer"], result: "i32" },
  GetSaveFileNameW: { parameters: ["buffer"], result: "i32" },
});
const shell32 = Deno.dlopen("shell32.dll", {
  SHBrowseForFolderW: { parameters: ["buffer"], result: "pointer" },
  // m6: SHGetPathFromIDListEx takes an explicit buffer size (chars), so it is not capped at
  // MAX_PATH the way the legacy SHGetPathFromIDListW is — a deep folder path is not truncated.
  SHGetPathFromIDListEx: { parameters: ["pointer", "buffer", "u32", "u32"], result: "i32" },
});
const ole32 = Deno.dlopen("ole32.dll", {
  CoInitializeEx: { parameters: ["pointer", "u32"], result: "i32" },
  CoUninitialize: { parameters: [], result: "void" },
  CoTaskMemFree: { parameters: ["pointer"], result: "void" },
});

function wide(s: string): Uint8Array {
  const buf = new Uint8Array((s.length + 1) * 2);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i), true);
  return buf;
}

function readWide(buf: Uint8Array): string {
  const v = new DataView(buf.buffer, buf.byteOffset);
  let s = "";
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = v.getUint16(i, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** "Label\0pattern\0...\0\0" filter block. Inputs are pre-sanitized by the server. */
function filterBlock(filters: [string, string][]): Uint8Array {
  let s = "";
  for (const [label, pattern] of filters) s += `${label}\u0000${pattern}\u0000`;
  s += "\u0000";
  const buf = new Uint8Array(s.length * 2);
  const v = new DataView(buf.buffer);
  for (let i = 0; i < s.length; i++) v.setUint16(i * 2, s.charCodeAt(i), true);
  return buf;
}

function ptrBig(p: Deno.PointerValue): bigint {
  return p === null ? 0n : BigInt(Deno.UnsafePointer.value(p));
}

function fileDialog(
  save: boolean,
  title: string,
  filters: [string, string][],
  defExt: string | null,
  owner: Deno.PointerValue,
): string | null {
  const fileBuf = new Uint8Array(MAX_PATH_BUF * 2);
  const titleBuf = wide(title);
  const filterBuf = filterBlock(filters.length > 0 ? filters : [["All files", "*.*"]]);
  const defExtBuf = defExt ? wide(defExt) : null;

  // OPENFILENAMEW (x64: 152 bytes)
  const ofn = new Uint8Array(152);
  const v = new DataView(ofn.buffer);
  v.setUint32(0, 152, true); // lStructSize
  v.setBigUint64(8, ptrBig(owner), true); // hwndOwner (m5: modal to the app window)
  v.setBigUint64(24, ptrBig(Deno.UnsafePointer.of(filterBuf)), true); // lpstrFilter
  v.setUint32(44, 1, true); // nFilterIndex
  v.setBigUint64(48, ptrBig(Deno.UnsafePointer.of(fileBuf)), true); // lpstrFile
  v.setUint32(56, MAX_PATH_BUF, true); // nMaxFile (chars)
  v.setBigUint64(88, ptrBig(Deno.UnsafePointer.of(titleBuf)), true); // lpstrTitle
  v.setUint32(
    96,
    OFN_EXPLORER | OFN_NOCHANGEDIR | (save ? OFN_OVERWRITEPROMPT : OFN_PATHMUSTEXIST),
    true,
  ); // Flags
  if (defExtBuf) v.setBigUint64(104, ptrBig(Deno.UnsafePointer.of(defExtBuf)), true); // lpstrDefExt

  const ok = save ? comdlg32.symbols.GetSaveFileNameW(ofn) : comdlg32.symbols.GetOpenFileNameW(ofn);
  return ok !== 0 ? readWide(fileBuf) : null;
}

function folderDialog(title: string, owner: Deno.PointerValue): string | null {
  const hr = ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  // i11: S_OK (0) or S_FALSE (1) mean this thread initialized COM and MUST balance it with
  // CoUninitialize; RPC_E_CHANGED_MODE (negative) means it was already initialized elsewhere
  // and we must NOT uninitialize it.
  const initialized = hr >= 0;
  try {
    const titleBuf = wide(title);
    const displayBuf = new Uint8Array(MAX_PATH_BUF * 2);

    // BROWSEINFOW (x64: 64 bytes)
    const bi = new Uint8Array(64);
    const v = new DataView(bi.buffer);
    v.setBigUint64(0, ptrBig(owner), true); // hwndOwner (m5: modal to the app window)
    v.setBigUint64(16, ptrBig(Deno.UnsafePointer.of(displayBuf)), true); // pszDisplayName
    v.setBigUint64(24, ptrBig(Deno.UnsafePointer.of(titleBuf)), true); // lpszTitle
    v.setUint32(32, BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE, true); // ulFlags

    const pidl = shell32.symbols.SHBrowseForFolderW(bi);
    if (pidl === null) return null;
    try {
      const pathBuf = new Uint8Array(MAX_PATH_BUF * 2);
      // m6: SHGetPathFromIDListEx with the real buffer size (chars) — not MAX_PATH-limited.
      if (shell32.symbols.SHGetPathFromIDListEx(pidl, pathBuf, MAX_PATH_BUF, GPFIDL_DEFAULT) === 0) {
        return null;
      }
      return readWide(pathBuf);
    } finally {
      ole32.symbols.CoTaskMemFree(pidl);
    }
  } finally {
    if (initialized) ole32.symbols.CoUninitialize();
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m?.type !== "pick") return;
  try {
    // m5: the app window HWND (decimal string) → an owner pointer, or null when unknown.
    const owner: Deno.PointerValue = typeof m.hwnd === "string" && m.hwnd !== ""
      ? Deno.UnsafePointer.create(BigInt(m.hwnd))
      : null;
    let path: string | null;
    if (m.kind === "folder") {
      path = folderDialog(m.title, owner);
    } else {
      path = fileDialog(m.kind === "file-save", m.title, m.filters, m.defExt ?? null, owner);
    }
    (self as unknown as Worker).postMessage(path === null ? { cancelled: true } : { path });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: String(err) });
  }
  self.close();
};

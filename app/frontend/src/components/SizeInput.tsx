import { useEffect, useRef, useState } from "react";

/** One size control, three target grammars (r8 D1).
 *
 * The UI is identical everywhere — a number field plus an [MB|GB] select — but the
 * string we emit follows each target's *documented* grammar:
 *   short → `512M` / `1G`   (wslc run -m, --shm-size, stack memory; decimals legal)
 *   long  → `512MB` / `4GB` (.wslconfig and `wsl --manage --resize`; integers only)
 * `memory=4G` is undocumented for .wslconfig — WSL may ignore the key and silently
 * fall back to 50% of RAM — so the suffix is never uniform. */
export type SizeUnit = "MB" | "GB";
export type SizeSuffix = "short" | "long";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  K: 1024,
  KB: 1024,
  M: MB,
  MB: MB,
  MI: MB, // 512Mi and 512M are both binary in the docker/k8s size grammar
  G: GB,
  GB: GB,
  GI: GB,
  T: 1024 * GB,
  TB: 1024 * GB,
  TI: 1024 * GB,
};

type Parsed =
  | { kind: "value"; num: string; unit: SizeUnit }
  /** The control cannot represent this string. DD2: we hand it back untouched. */
  | { kind: "raw" };

/** Reads an existing value into number+unit, or declares it unrepresentable.
 *
 * DD2 — never silently rewrite a user's `.wslconfig`. Anything we cannot render
 * *exactly* (`50%`, `1.5MB`, a byte count that is not a whole MB/GB) comes back as
 * "raw" and is passed through character-for-character. `0` is a documented value
 * ("0 for no swap file") and stays valid. A bare byte count is normalised to the
 * largest exact unit, which is what turns `defaultVhdSize=1099511627776` into 1024 GB. */
export function parseSize(
  raw: string,
  units: SizeUnit[],
  integersOnly: boolean,
  preferred: SizeUnit = "GB",
): Parsed {
  const fallback: SizeUnit = units.includes(preferred) ? preferred : units[0];
  const t = raw.trim();
  if (t === "") return { kind: "value", num: "", unit: fallback };
  if (/^0+$/.test(t)) return { kind: "value", num: "0", unit: fallback };

  const m = /^(\d+(?:\.\d+)?)\s*(B|K|KB|M|MB|MI|G|GB|GI|T|TB|TI)?$/i.exec(t);
  if (!m) return { kind: "raw" };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { kind: "raw" };
  const u = (m[2] ?? "B").toUpperCase();

  // A unit the control already speaks: keep it as written rather than normalising
  // (`512M` stays 512 MB — it must not become 0.5 GB behind the user's back).
  const family: SizeUnit | null = u === "M" || u === "MB" || u === "MI"
    ? "MB"
    : u === "G" || u === "GB" || u === "GI"
    ? "GB"
    : null;
  if (family && units.includes(family) && (!integersOnly || Number.isInteger(n))) {
    return { kind: "value", num: String(n), unit: family };
  }

  // Otherwise the only honest move is an exact conversion; inexact → raw.
  const bytes = n * UNIT_BYTES[u];
  if (!Number.isInteger(bytes)) return { kind: "raw" };
  if (units.includes("GB") && bytes % GB === 0) return { kind: "value", num: String(bytes / GB), unit: "GB" };
  if (units.includes("MB") && bytes % MB === 0) return { kind: "value", num: String(bytes / MB), unit: "MB" };
  return { kind: "raw" };
}

/** number+unit → the target's documented string. `0` stays bare `0`. */
export function formatSize(num: string, unit: SizeUnit, suffix: SizeSuffix): string {
  const t = num.trim();
  if (t === "") return "";
  if (/^0+(?:\.0+)?$/.test(t)) return "0";
  const s = suffix === "short" ? (unit === "MB" ? "M" : "G") : unit;
  return `${t}${s}`;
}

export interface SizeInputProps {
  value: string;
  onChange: (next: string) => void;
  /** Names both controls for screen readers: "<label> value" / "<label> unit". */
  label: string;
  suffix: SizeSuffix;
  units?: SizeUnit[];
  /** `.wslconfig` ("whole numbers using GB or MB") and --resize ("decimal values are
   * currently unsupported") reject decimals; `wslc run -m` accepts them. */
  integersOnly?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Rendered under the control when the value is a documented `0`. */
  zeroHint?: string;
  /** Unit an empty field starts on. Defaults to the one that matches the target's own
   * conventions: MB for the docker-style targets (`-m 512M`), GB for `.wslconfig`/resize
   * (`memory=4GB`). Getting this wrong turns a `512` placeholder into 512 *GB*. */
  defaultUnit?: SizeUnit;
  style?: React.CSSProperties;
}

export function SizeInput({
  value,
  onChange,
  label,
  suffix,
  units = ["MB", "GB"],
  integersOnly = false,
  placeholder,
  disabled,
  zeroHint,
  defaultUnit,
  style,
}: SizeInputProps) {
  const preferred: SizeUnit = defaultUnit ?? (suffix === "short" ? "MB" : "GB");
  const [state, setState] = useState<Parsed>(() => parseSize(value, units, integersOnly, preferred));
  /** The last string this control produced. Anything else arriving in `value` came
   * from outside (a reload, a reset) and must be re-read. */
  const emitted = useRef(value);
  const unitsKey = units.join(",");

  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setState(parseSize(value, units, integersOnly, preferred));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, unitsKey, integersOnly, preferred]);

  const emit = (num: string, unit: SizeUnit) => {
    const next = formatSize(num, unit, suffix);
    emitted.current = next;
    setState({ kind: "value", num, unit });
    onChange(next);
  };

  if (state.kind === "raw") {
    return (
      <span className="sizeinput raw" style={style}>
        <span className="pickrow">
          <input
            type="text"
            className="mono"
            value={value}
            disabled={disabled}
            aria-label={`${label} (raw value, kept as written)`}
            onChange={(e) => {
              // Pass through untouched. Deliberately does NOT re-parse here: swapping to the
              // MB/GB control mid-keystroke (the moment "5" of "50%" parses) would unmount the
              // field under the user's cursor. The mode decision waits for blur.
              emitted.current = e.target.value;
              onChange(e.target.value);
            }}
            onBlur={(e) => setState(parseSize(e.target.value, units, integersOnly, preferred))}
          />
          <span
            className="badge warn"
            title="This value has no exact MB/GB form, so it is kept exactly as written and is never rewritten for you. Replace it with a plain number to get the MB/GB control back."
          >
            raw value
          </span>
        </span>
        {!disabled && (
          <span className="sizehint muted">
            Kept exactly as written. Enter a plain number to switch back to MB/GB.
          </span>
        )}
      </span>
    );
  }

  const isZero = /^0+$/.test(state.num);

  return (
    <span className="sizeinput" style={style}>
      <input
        type="number"
        min="0"
        step={integersOnly ? "1" : "any"}
        inputMode={integersOnly ? "numeric" : "decimal"}
        value={state.num}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={`${label} value`}
        onChange={(e) => {
          const raw = e.target.value;
          const cleaned = integersOnly ? raw.replace(/[^\d]/g, "") : raw.replace(/[^\d.]/g, "");
          emit(cleaned, state.unit);
        }}
      />
      <select
        value={state.unit}
        disabled={disabled}
        aria-label={`${label} unit`}
        onChange={(e) => emit(state.num, e.target.value as SizeUnit)}
      >
        {units.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      {isZero && zeroHint && <span className="sizehint muted">{zeroHint}</span>}
    </span>
  );
}

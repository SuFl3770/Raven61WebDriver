/** Byte <-> text helpers shared by the console, the traffic log and the pcap importer. */

export function toHex(bytes: ArrayLike<number>, sep = ' '): string {
  const out: string[] = []
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!.toString(16).padStart(2, '0'))
  return out.join(sep)
}

export function toAscii(bytes: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
  }
  return out
}

/**
 * Parses loose hex input. Accepts "01 02 0a", "0102 0A", "0x01,0x02", "01-02".
 * Also accepts decimal when the token is prefixed with `d` (e.g. `d255`) so the
 * console can express "255" without ambiguity.
 */
export function parseBytes(text: string): Uint8Array {
  const tokens = text.trim().split(/[\s,;\-_]+/).filter(Boolean)
  const out: number[] = []
  for (const raw of tokens) {
    if (/^d\d+$/i.test(raw)) {
      const v = Number(raw.slice(1))
      if (v > 0xff) throw new Error(`decimal out of range: ${raw}`)
      out.push(v)
      continue
    }
    const t = raw.replace(/^0x/i, '')
    if (!/^[0-9a-f]+$/i.test(t)) throw new Error(`not hex: ${raw}`)
    if (t.length % 2 !== 0) throw new Error(`odd hex digit count: ${raw}`)
    for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16))
  }
  return new Uint8Array(out)
}

/** Canonical hex dump: `0000  01 02 .. 10  |....|` — the format used for copy/paste into notes. */
export function hexDump(bytes: ArrayLike<number>, width = 16): string {
  const lines: string[] = []
  for (let off = 0; off < bytes.length; off += width) {
    const slice = Array.prototype.slice.call(bytes, off, off + width) as number[]
    const hex = toHex(slice).padEnd(width * 3 - 1, ' ')
    lines.push(`${off.toString(16).padStart(4, '0')}  ${hex}  |${toAscii(slice)}|`)
  }
  return lines.join('\n')
}

/** Index positions where two buffers differ — the backbone of every diff view. */
export function diffOffsets(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const n = Math.max(a.length, b.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i)
  return out
}

export function equalBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

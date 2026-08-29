import { toHex } from './hex'

export type Direction = 'out' | 'in' | 'feature-set' | 'feature-get' | 'note'

export interface TrafficEntry {
  seq: number
  /** ms since the log was created — a monotonic clock beats wall time for timing analysis. */
  t: number
  dir: Direction
  reportId: number
  data: Uint8Array
  /** Free-form annotation: which UI action produced this, or a decoded summary. */
  note?: string
}

type Listener = (entries: readonly TrafficEntry[]) => void

/**
 * Ring buffer of every byte that crossed the wire. This is the primary
 * reverse-engineering artifact: capture here, export, diff against USBPcap.
 */
export class TrafficLog {
  private entries: TrafficEntry[] = []
  private listeners = new Set<Listener>()
  private seq = 0
  private readonly t0 = performance.now()

  constructor(private readonly limit = 5000) {}

  push(dir: Direction, reportId: number, data: Uint8Array, note?: string): TrafficEntry {
    const entry: TrafficEntry = {
      seq: this.seq++,
      t: Math.round((performance.now() - this.t0) * 1000) / 1000,
      dir,
      reportId,
      data,
      note,
    }
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    this.emit()
    return entry
  }

  note(text: string): void {
    this.push('note', 0, new Uint8Array(0), text)
  }

  clear(): void {
    this.entries = []
    this.emit()
  }

  all(): readonly TrafficEntry[] {
    return this.entries
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    fn(this.entries)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const snapshot = this.entries.slice()
    for (const fn of this.listeners) fn(snapshot)
  }

  /** Tab-separated text — pastes cleanly into a spreadsheet or a notes file. */
  toText(): string {
    return this.entries
      .map((e) =>
        e.dir === 'note'
          ? `${e.t.toFixed(3)}\tNOTE\t\t${e.note ?? ''}`
          : `${e.t.toFixed(3)}\t${e.dir}\t${e.reportId}\t${toHex(e.data)}\t${e.note ?? ''}`,
      )
      .join('\n')
  }

  toJSON(): string {
    return JSON.stringify(
      this.entries.map((e) => ({
        seq: e.seq,
        t: e.t,
        dir: e.dir,
        reportId: e.reportId,
        data: Array.from(e.data),
        note: e.note,
      })),
      null,
      2,
    )
  }
}

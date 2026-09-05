import { TrafficLog } from './log'
import { featureReports, inputReports, outputReports, padToReport, type ReportSpec } from './reportInfo'

export class HidError extends Error {}
export class TimeoutError extends HidError {}

export interface RequestOptions {
  /** Report id to write on. Defaults to the first declared output report. */
  reportId?: number
  /** Accepts an input report as the answer. Defaults to "the next input report". */
  match?: (reportId: number, data: Uint8Array) => boolean
  timeoutMs?: number
  note?: string
}

type InputListener = (reportId: number, data: Uint8Array) => void
type ChangeListener = () => void

interface Waiter {
  match: (reportId: number, data: Uint8Array) => boolean
  resolve: (v: { reportId: number; data: Uint8Array }) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Protocol-agnostic transport over one WebHID device.
 *
 * Everything above this layer (codecs, feature panels) speaks in terms of
 * `request`/`send`; this class owns the device handle, the traffic log and the
 * request/response correlation that an unknown protocol still needs.
 */
export class HidLink {
  readonly log: TrafficLog
  private dev: HIDDevice | null = null
  private outSpecs: ReportSpec[] = []
  private inSpecs: ReportSpec[] = []
  private featSpecs: ReportSpec[] = []
  private waiters: Waiter[] = []
  private inputListeners = new Set<InputListener>()
  private changeListeners = new Set<ChangeListener>()
  private readonly onInputReport = (e: HIDInputReportEvent) => this.handleInput(e)
  private readonly onDisconnect = (e: HIDConnectionEvent) => {
    if (e.device === this.dev) this.detach('device disconnected')
  }

  constructor(log = new TrafficLog()) {
    this.log = log
    if (HidLink.supported()) navigator.hid.addEventListener('disconnect', this.onDisconnect)
  }

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'hid' in navigator
  }

  get device(): HIDDevice | null {
    return this.dev
  }

  get connected(): boolean {
    return this.dev?.opened ?? false
  }

  get specs(): { input: ReportSpec[]; output: ReportSpec[]; feature: ReportSpec[] } {
    return { input: this.inSpecs, output: this.outSpecs, feature: this.featSpecs }
  }

  /** Devices the user already granted permission to, in an earlier session. */
  async knownDevices(): Promise<HIDDevice[]> {
    if (!HidLink.supported()) return []
    return navigator.hid.getDevices()
  }

  /**
   * Must be called from a user gesture — Chrome requires it for the picker.
   *
   * The chooser lists physical devices, so one pick can return several
   * interfaces of the same keyboard. `choose` decides which of them to open;
   * the default keeps the browser's order, which is rarely the right one for a
   * composite device.
   */
  async pickDevice(
    filters: HIDDeviceFilter[] = [],
    choose: (devices: readonly HIDDevice[]) => HIDDevice | null = (d) => d[0] ?? null,
  ): Promise<HIDDevice | null> {
    if (!HidLink.supported()) throw new HidError('WebHID is unavailable in this browser')
    const devices = await navigator.hid.requestDevice({ filters })
    if (devices.length === 0) return null
    const picked = choose(devices) ?? devices[0]!
    if (devices.length > 1) {
      this.log.note(
        `picked interface ${devices.indexOf(picked) + 1}/${devices.length} of ` +
          `${picked.productName || 'device'}`,
      )
    }
    await this.open(picked)
    return picked
  }

  async open(device: HIDDevice): Promise<void> {
    if (this.dev && this.dev !== device) await this.close()
    if (!device.opened) await device.open()
    this.dev = device
    this.inSpecs = inputReports(device)
    this.outSpecs = outputReports(device)
    this.featSpecs = featureReports(device)
    device.addEventListener('inputreport', this.onInputReport)
    this.log.note(
      `opened ${device.productName || 'device'} ` +
        `VID=0x${device.vendorId.toString(16).padStart(4, '0')} ` +
        `PID=0x${device.productId.toString(16).padStart(4, '0')}`,
    )
    this.emitChange()
  }

  async close(): Promise<void> {
    const d = this.dev
    if (!d) return
    d.removeEventListener('inputreport', this.onInputReport)
    try {
      if (d.opened) await d.close()
    } finally {
      this.detach('closed')
    }
  }

  private detach(reason: string): void {
    this.dev = null
    this.inSpecs = []
    this.outSpecs = []
    this.featSpecs = []
    this.failAllWaiters(new HidError(reason))
    this.log.note(reason)
    this.emitChange()
  }

  private defaultOutReportId(): number {
    return this.outSpecs[0]?.reportId ?? 0
  }

  // --- traffic -------------------------------------------------------------

  /**
   * One exchange at a time, in call order.
   *
   * The board has a single HID packet buffer (`gp + 0x134`), so a second write
   * that lands before the firmware has picked up the first replaces it — and
   * the first command is answered by nothing at all. It is not a theory: a
   * capture has `55 aa` (calibration table) and `55 01` (keymap begin) written
   * in the same millisecond, the board answering only the second, and the
   * calibration read timing out while fourteen keymap chunks went through
   * beside it. Two callers with no knowledge of each other is all it takes;
   * there it was a `Promise.all` in `useCalibrationRun`.
   *
   * So every write goes through here, `send` included: a fire-and-forget packet
   * clobbers an in-flight request exactly as well as a request does, which is
   * what the 1500 ms calibration re-arm would otherwise do.
   *
   * Order is FIFO and the chain never breaks — a rejected exchange must not
   * take the queue down with it, so failures are absorbed here and re-thrown to
   * their own caller.
   */
  private queue: Promise<unknown> = Promise.resolve()

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)`, not `.then(fn)`: the next turn is taken whether the
    // exchange before it resolved or rejected.
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async send(data: Uint8Array, reportId = this.defaultOutReportId(), note?: string): Promise<void> {
    return this.enqueue(() => this.writeNow(data, reportId, note))
  }

  /** The write itself, already at the head of the queue. */
  private async writeNow(
    data: Uint8Array,
    reportId = this.defaultOutReportId(),
    note?: string,
  ): Promise<void> {
    const d = this.requireDevice()
    const payload = padToReport(this.outSpecs, reportId, data)
    this.log.push('out', reportId, payload, note)
    await d.sendReport(reportId, payload)
  }

  /**
   * Feature reports go through the same queue as everything else — a different
   * pipe on the host, but the same firmware on the other end. What it does not
   * do is make a set/get *pair* atomic; a caller that needs the two to belong
   * together has to say so, and none does yet.
   */
  async setFeature(data: Uint8Array, reportId = this.featSpecs[0]?.reportId ?? 0, note?: string): Promise<void> {
    return this.enqueue(async () => {
      const d = this.requireDevice()
      const payload = padToReport(this.featSpecs, reportId, data)
      this.log.push('feature-set', reportId, payload, note)
      await d.sendFeatureReport(reportId, payload)
    })
  }

  async getFeature(reportId = this.featSpecs[0]?.reportId ?? 0, note?: string): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const d = this.requireDevice()
      const view = await d.receiveFeatureReport(reportId)
      const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      this.log.push('feature-get', reportId, data, note)
      return data
    })
  }

  /**
   * Write, then resolve with the first input report that satisfies `match`.
   *
   * The wait is part of the exchange, not something that happens beside it:
   * the queue is held until the reply lands or the timeout expires, which is
   * what keeps the next caller's packet out of the board's buffer. The timeout
   * therefore measures the device, not the queue — time spent waiting for a
   * turn is not charged against it.
   */
  async request(data: Uint8Array, opts: RequestOptions = {}): Promise<{ reportId: number; data: Uint8Array }> {
    const { timeoutMs = 1000, match = () => true, note } = opts
    return this.enqueue(async () => {
      const answer = this.waitFor(match, timeoutMs)
      // Attach the waiter before writing: a fast device can answer within the
      // same task, and losing that race would look like a dead command.
      try {
        await this.writeNow(data, opts.reportId ?? this.defaultOutReportId(), note)
      } catch (e) {
        this.failAllWaiters(e instanceof Error ? e : new HidError(String(e)))
        throw e
      }
      return answer
    })
  }

  waitFor(
    match: (reportId: number, data: Uint8Array) => boolean,
    timeoutMs = 1000,
  ): Promise<{ reportId: number; data: Uint8Array }> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(new TimeoutError(`no matching input report within ${timeoutMs} ms`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  private handleInput(e: HIDInputReportEvent): void {
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)
    this.log.push('in', e.reportId, data)
    for (const fn of this.inputListeners) fn(e.reportId, data)
    const hit = this.waiters.find((w) => w.match(e.reportId, data))
    if (hit) {
      clearTimeout(hit.timer)
      this.waiters = this.waiters.filter((w) => w !== hit)
      hit.resolve({ reportId: e.reportId, data })
    }
  }

  private failAllWaiters(err: Error): void {
    const pending = this.waiters
    this.waiters = []
    for (const w of pending) {
      clearTimeout(w.timer)
      w.reject(err)
    }
  }

  private requireDevice(): HIDDevice {
    if (!this.dev?.opened) throw new HidError('no device is open')
    return this.dev
  }

  // --- subscriptions -------------------------------------------------------

  onInput(fn: InputListener): () => void {
    this.inputListeners.add(fn)
    return () => this.inputListeners.delete(fn)
  }

  onChange(fn: ChangeListener): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) fn()
  }
}

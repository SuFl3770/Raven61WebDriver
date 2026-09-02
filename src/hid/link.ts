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

  async send(data: Uint8Array, reportId = this.defaultOutReportId(), note?: string): Promise<void> {
    const d = this.requireDevice()
    const payload = padToReport(this.outSpecs, reportId, data)
    this.log.push('out', reportId, payload, note)
    await d.sendReport(reportId, payload)
  }

  async setFeature(data: Uint8Array, reportId = this.featSpecs[0]?.reportId ?? 0, note?: string): Promise<void> {
    const d = this.requireDevice()
    const payload = padToReport(this.featSpecs, reportId, data)
    this.log.push('feature-set', reportId, payload, note)
    await d.sendFeatureReport(reportId, payload)
  }

  async getFeature(reportId = this.featSpecs[0]?.reportId ?? 0, note?: string): Promise<Uint8Array> {
    const d = this.requireDevice()
    const view = await d.receiveFeatureReport(reportId)
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    this.log.push('feature-get', reportId, data, note)
    return data
  }

  /** Write, then resolve with the first input report that satisfies `match`. */
  async request(data: Uint8Array, opts: RequestOptions = {}): Promise<{ reportId: number; data: Uint8Array }> {
    const { timeoutMs = 1000, match = () => true, note } = opts
    const answer = this.waitFor(match, timeoutMs)
    // Attach the waiter before writing: a fast device can answer within the
    // same task, and losing that race would look like a dead command.
    try {
      await this.send(data, opts.reportId ?? this.defaultOutReportId(), note)
    } catch (e) {
      this.failAllWaiters(e instanceof Error ? e : new HidError(String(e)))
      throw e
    }
    return answer
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

/**
 * The demo board, dressed as a WebHID device.
 *
 * `HidLink` owns a `HIDDevice` and nothing else — it opens it, writes output
 * reports to it and listens for `inputreport` events. That is a small enough
 * surface to stand up in software, and standing it up here rather than teaching
 * the link about a demo mode is what keeps the demo honest: every layer above
 * this one is running the code it runs against hardware, including the parts
 * that are easy to get wrong, like waiting for a chunk that never comes.
 *
 * It also means the demo works in a browser that has no WebHID at all. Nothing
 * on this path touches `navigator.hid`, so Firefox and Safari get the whole UI
 * — see `HidLink.supported()`, which the connect screen still reports honestly
 * for real hardware.
 */

import { DemoBoard } from './board'

/** The descriptor a Raven61's vendor interface presents, as far as this app reads it. */
function collections(payloadLength: number): HIDCollectionInfo[] {
  const report = {
    reportId: 0,
    items: [{ reportSize: 8, reportCount: payloadLength }],
  }
  return [
    {
      usagePage: 0xff00,
      usage: 0x01,
      inputReports: [report],
      outputReports: [report],
      featureReports: [],
      children: [],
    },
  ]
}

export interface DemoDeviceOptions {
  vendorId: number
  productId: number
  productName: string
  payloadLength: number
}

/**
 * Implements the members of `HIDDevice` this app uses, and no more.
 *
 * Not `implements HIDDevice`: the real interface is a browser class with an
 * `oninputreport` property and typed listener overloads, none of which the link
 * touches. Callers cast once, at the point where the demo is handed over — see
 * `state/demo.ts`.
 */
export class DemoHidDevice extends EventTarget {
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  readonly collections: HIDCollectionInfo[]
  readonly board = new DemoBoard()

  private open_ = false

  constructor(opts: DemoDeviceOptions) {
    super()
    this.vendorId = opts.vendorId
    this.productId = opts.productId
    this.productName = opts.productName
    this.collections = collections(opts.payloadLength)
    this.board.emit = (payload) => this.dispatchInput(payload)
  }

  get opened(): boolean {
    return this.open_
  }

  async open(): Promise<void> {
    if (this.open_) return
    this.open_ = true
    this.board.start()
  }

  async close(): Promise<void> {
    if (!this.open_) return
    this.open_ = false
    this.board.stop()
  }

  /** Nothing was granted, so there is nothing to revoke. */
  async forget(): Promise<void> {
    await this.close()
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (!this.open_) throw new Error('the demo device is not open')
    if (reportId !== 0) return
    this.board.handle(bytesOf(data))
  }

  /** The Raven61 declares no feature reports, and neither does this. */
  async sendFeatureReport(): Promise<void> {
    throw new Error('the demo device declares no feature reports')
  }

  async receiveFeatureReport(): Promise<DataView> {
    throw new Error('the demo device declares no feature reports')
  }

  private dispatchInput(payload: Uint8Array): void {
    if (!this.open_) return
    // `HIDInputReportEvent` is a browser class, and in a browser without WebHID
    // there is no such constructor to call. The link reads `reportId` and
    // `data` off the event and nothing else, so a plain Event carrying those
    // two is indistinguishable from the real thing where it matters.
    const event = new Event('inputreport')
    Object.assign(event, {
      device: this,
      reportId: 0,
      data: new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    })
    this.dispatchEvent(event)
  }
}

function bytesOf(data: BufferSource): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

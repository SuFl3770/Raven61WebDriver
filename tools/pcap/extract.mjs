#!/usr/bin/env node
/**
 * Turns a USBPcap/Wireshark capture into the same line format the in-app
 * traffic log exports, so captures from the stock driver and from this web
 * driver can be diffed side by side.
 *
 * Input: `tshark -r capture.pcapng -T json` output (a .json file), or the
 * raw pcapng piped through tshark by this script when tshark is on PATH.
 *
 *   node tools/pcap/extract.mjs capture.json
 *   node tools/pcap/extract.mjs capture.pcapng            # runs tshark for you
 *   node tools/pcap/extract.mjs --unique capture.json     # collapse repeats
 *   node tools/pcap/extract.mjs --diff before.json after.json
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname } from 'node:path'

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const files = args.filter((a) => !a.startsWith('--'))

if (files.length === 0) {
  console.error('usage: extract.mjs [--unique] [--min-len N] <capture.json|capture.pcapng> [second.json]')
  process.exit(1)
}

const minLen = (() => {
  const i = args.indexOf('--min-len')
  return i >= 0 ? Number(args[i + 1]) : 1
})()

/** Hex fields come as "01:02:0a" from tshark. */
function bytesOf(text) {
  if (!text) return null
  const clean = String(text).replace(/[:\s]/g, '')
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length === 0) return null
  const out = []
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16))
  return out
}

function loadPackets(file) {
  let json
  if (extname(file).toLowerCase() === '.json') {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } else {
    const out = execFileSync('tshark', ['-r', file, '-T', 'json'], {
      maxBuffer: 1 << 30,
      encoding: 'utf8',
    })
    json = JSON.parse(out)
  }
  return json
}

function extract(file) {
  const packets = loadPackets(file)
  const rows = []
  for (const p of packets) {
    const layers = p?._source?.layers ?? {}
    const usb = layers.usb ?? {}
    const data =
      bytesOf(layers['usb.capdata']) ??
      bytesOf(usb['usb.capdata']) ??
      bytesOf(layers['usbhid.data']) ??
      bytesOf(layers['Leftover Capture Data']) ??
      bytesOf(usb['usb.data_fragment'])
    if (!data || data.length < minLen) continue

    // usb.endpoint_address.direction: 1 = device→host (IN), 0 = host→device (OUT).
    const dirBit = usb['usb.endpoint_address_tree']?.['usb.endpoint_address.direction']
    const dir = dirBit === '1' || dirBit === 1 ? 'in' : 'out'
    const time = Number(layers.frame?.['frame.time_relative'] ?? 0)
    const ep = usb['usb.endpoint_address'] ?? ''
    rows.push({ time, dir, ep, data })
  }
  return rows
}

const hex = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ')

function print(rows) {
  const seen = new Set()
  for (const r of rows) {
    const line = `${r.time.toFixed(6)}\t${r.dir}\t${r.ep}\t${hex(r.data)}`
    if (flags.has('--unique')) {
      const key = `${r.dir}|${hex(r.data)}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    console.log(line)
  }
  console.error(`# ${rows.length} HID payload(s)${flags.has('--unique') ? `, ${seen.size} unique` : ''}`)
}

if (flags.has('--diff')) {
  if (files.length < 2) {
    console.error('--diff needs two captures')
    process.exit(1)
  }
  const [a, b] = files.map(extract)
  const keyOf = (r) => `${r.dir}|${hex(r.data)}`
  const setA = new Set(a.map(keyOf))
  const setB = new Set(b.map(keyOf))
  console.log('# 두 번째 캡처에만 있는 프레임 (설정 변경으로 새로 나타난 명령)')
  for (const k of setB) if (!setA.has(k)) console.log(`+ ${k.replace('|', '\t')}`)
  console.log('# 첫 번째 캡처에만 있는 프레임')
  for (const k of setA) if (!setB.has(k)) console.log(`- ${k.replace('|', '\t')}`)
} else {
  print(extract(files[0]))
}

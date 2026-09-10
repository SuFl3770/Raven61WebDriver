/*
 * Traces the Raven61 stock driver's HID traffic.
 *
 *   pip install frida-tools
 *   frida -f "Raven Driver.exe" -l tools/frida/trace-hid.js
 *
 * The driver does NOT use HidD_SetFeature — it opens the HID device with
 * CreateFile and moves 65-byte OUTPUT/INPUT reports through WriteFile and
 * ReadFile, so those are what we hook. See docs/protocol.md §1.
 *
 * Only buffers of the packet size are printed, which filters out the driver's
 * unrelated file I/O (its SQLite database, logs, downloads).
 */

const PACKET_SIZE = 65;
const MAGIC = 0x55;
const MAGIC_FIRMWARE = 0x5f;
const ACK = 0xaa;

const COMMANDS = {
  0x01: 'begin',
  0x02: 'end/apply',
  0x06: 'globalSettings',
  0x09: '?',
  0x0b: '?',
  0x0d: '?',
  0xa1: '?',
  0xa3: '?',
  0xa5: '?',
  0xa7: '?',
  0xa8: '?',
  0xa9: '?',
  0xdd: '?',
};

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => ('0' + b.toString(16)).slice(-2))
    .join(' ');
}

function checksum(payload) {
  // payload[3] covers payload[4..63]; see src/protocol/frame.ts
  let sum = 0;
  for (let i = 4; i < 64; i++) sum += payload[i];
  return sum & 0xff;
}

function dump(direction, bytes) {
  // WriteFile buffers carry the report id at [0]; ReadFile buffers do too.
  const payload = bytes.slice(1);
  const magic = payload[0];
  const cmd = payload[1];

  const lines = [];
  if (direction === 'OUT') {
    const ok = payload[3] === checksum(payload);
    const named = COMMANDS[cmd] ? ` (${COMMANDS[cmd]})` : '';
    const magicName =
      magic === MAGIC ? 'config' : magic === MAGIC_FIRMWARE ? 'firmware' : 'unknown';
    lines.push(
      `--> OUT  magic=0x${magic.toString(16)} (${magicName}) ` +
        `cmd=0x${('0' + cmd.toString(16)).slice(-2)}${named} ` +
        `checksum ${ok ? 'ok' : 'MISMATCH'}`,
    );
  } else {
    lines.push(`<-- IN   ${payload[0] === ACK ? 'ACK' : `first byte 0x${payload[0].toString(16)}`}`);
  }

  for (let off = 0; off < payload.length; off += 16) {
    lines.push(`     ${('000' + off.toString(16)).slice(-4)}  ${hex(payload.slice(off, off + 16))}`);
  }
  console.log(lines.join('\n'));
}

const writeFile = Module.getExportByName('kernel32.dll', 'WriteFile');
const readFile = Module.getExportByName('kernel32.dll', 'ReadFile');

Interceptor.attach(writeFile, {
  onEnter(args) {
    const size = args[2].toInt32();
    if (size !== PACKET_SIZE) return;
    dump('OUT', new Uint8Array(args[1].readByteArray(size)));
  },
});

Interceptor.attach(readFile, {
  onEnter(args) {
    // ReadFile is asynchronous here, so the buffer is only filled on return.
    this.buffer = args[1];
    this.size = args[2].toInt32();
    this.bytesRead = args[3];
  },
  onLeave() {
    if (this.size !== PACKET_SIZE) return;
    let n = this.size;
    if (!this.bytesRead.isNull()) {
      const reported = this.bytesRead.readU32();
      if (reported > 0) n = Math.min(reported, this.size);
    }
    dump('IN', new Uint8Array(this.buffer.readByteArray(n)));
  },
});

console.log(`[*] tracing ${PACKET_SIZE}-byte HID reports — change a setting in the driver`);

"""
Recovers the Raven61 command table from the stock driver binary.

Commands go through a send-and-wait-for-ACK helper. Each caller builds a
65-byte packet in a stack local and stores its header bytes as immediates, so
disassembling each caller and collecting the `mov byte [ebp-N], imm8` stores
that land in that local reconstructs the command headers without ever running
the program.

There are TWO such helpers, and that matters: the first version of this script
only knew about 0x45a940 and so reported writes only. Every read command hangs
off 0x45ab50 — same framing, slightly different retry and checksum range — and
missing it left the protocol spec with no way to get anything back off the
board. See docs/protocol.md §1.1.
"""
import re
import struct
import sys

from capstone import CS_ARCH_X86, CS_MODE_32, Cs
from pe import PE

# Both send-and-wait helpers, and what each is used for.
HELPERS = {
    0x45A940: 'ack',    # write commands: send, read reply, check payload[0] == 0xAA
    0x45AB50: 'query',  # read commands: same, and the reply carries data
}
PACKET_LEN = 0x41


def load(path):
    pe = PE(path)
    sec = pe.section('.text')
    return pe, sec, pe.image_base + sec['va'], pe.data[sec['raw']:sec['raw'] + sec['rsize']]


def callers(blob, base, target):
    out = []
    for i in range(len(blob) - 5):
        if blob[i] == 0xE8:
            rel = struct.unpack_from('<i', blob, i + 1)[0]
            if base + i + 5 + rel == target:
                out.append(base + i)
    return out


def func_start(blob, base, addr):
    i = addr - base
    while i > 2:
        if blob[i - 1] == 0xCC and blob[i] == 0x55 and blob[i + 1] == 0x8B and blob[i + 2] == 0xEC:
            return base + i
        i -= 1
    return None


def analyse(path):
    pe, sec, base, blob = load(path)
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    out = []

    sites = [(site, helper) for helper in HELPERS for site in callers(blob, base, helper)]
    for site, helper in sites:
        start = func_start(blob, base, site)
        if start is None:
            continue
        off = sec['raw'] + (start - base)
        insns = list(md.disasm(pe.data[off:off + (site - start) + 8], start))

        # The packet pointer is the `lea reg, [ebp - K]` pushed just before the call.
        buf = None
        for i in reversed(insns):
            if i.address >= site:
                continue
            if i.mnemonic == 'lea' and 'ebp -' in i.op_str:
                buf = int(i.op_str.split('ebp -')[1].strip(' ]'), 16)
                break
        if buf is None:
            continue

        # Immediate stores that land inside that 65-byte local. The compiler
        # merges adjacent header bytes into word/dword stores, so each one is
        # decomposed back into little-endian bytes.
        widths = {'byte': 1, 'word': 2, 'dword': 4}
        fields = {}
        for i in insns:
            m = re.match(r'(byte|word|dword) ptr \[ebp - (0x[0-9a-f]+)\], (\S+)$', i.op_str)
            if i.mnemonic != 'mov' or not m:
                continue
            width, disp, val = widths[m.group(1)], int(m.group(2), 16), m.group(3)
            try:
                num = int(val, 0)
            except ValueError:
                continue
            idx = buf - disp
            for n in range(width):
                if 0 <= idx + n < PACKET_LEN:
                    fields[idx + n] = (num >> (8 * n)) & 0xFF

        out.append({'site': site, 'func': start, 'buf': buf, 'fields': fields,
                    'helper': helper, 'kind': HELPERS[helper]})
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'Raven Driver/Raven Driver.exe'
    rows = analyse(path)

    # buffer[0] is the HID report id, so payload[n] lives at buffer[n + 1].
    def fmt(v):
        return f'0x{v:02x}' if v is not None else '-'

    known = [r for r in rows if 2 in r['fields']]
    print(f'# {len(rows)} call sites, {len(known)} with a constant command byte')
    for helper, kind in HELPERS.items():
        n = sum(1 for r in rows if r['helper'] == helper)
        print(f'#   0x{helper:08x} ({kind}): {n}')
    print()
    print(f"{'call site':<12}{'func':<12}{'via':<8}{'magic':<9}{'cmd':<7}"
          'other constant payload bytes')
    for r in sorted(rows, key=lambda x: (x['fields'].get(2, 0xFFF), x['site'])):
        f = r['fields']
        rest = ', '.join(f'p[{i - 1}]=0x{v:02x}' for i, v in sorted(f.items()) if i > 2)
        print(f'{hex(r["site"]):<12}{hex(r["func"]):<12}{r["kind"]:<8}'
              f'{fmt(f.get(1)):<9}{fmt(f.get(2)):<7}{rest}')

    # A read command that answers with data is the interesting half, so call it
    # out rather than leaving it to be spotted in the listing.
    reads = sorted({f['fields'][2] for f in rows
                    if f['kind'] == 'query' and 2 in f['fields']})
    writes = sorted({f['fields'][2] for f in rows
                     if f['kind'] == 'ack' and 2 in f['fields']})
    print()
    print('# read commands  (via the query helper): ' + ' '.join(f'0x{c:02x}' for c in reads))
    print('# write commands (via the ack helper)  : ' + ' '.join(f'0x{c:02x}' for c in writes))
    print('# NOTE 0xee (factory reset) is sent from 0x443540 and does not appear here.')


if __name__ == '__main__':
    main()

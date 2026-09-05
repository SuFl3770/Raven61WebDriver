"""Reader and disassembler for the Raven61 keyboard firmware.

The firmware is not distributed on its own. It ships inside the vendor's
updater, `Raven FW/FW.exe`, as resource `BIN` / 134 - 121584 bytes of RISC-V
that identifies itself as `HALL_HS_USB_KB`, built Nov 13 2024. `Raven FW/` is
gitignored for the same reason `Raven Driver/` is: not ours to redistribute.

Two things make the image awkward to read with stock tools, and both are
handled here:

**It is not based at zero.** The first word of the vector table at file offset
0x38 is 0x5000, and the command dispatch table the code indexes at 0x157b0 sits
at file offset 0x107b0. So `flash = file + 0x5000`, and every absolute pointer
in the image - jump tables, the flash-resident config blobs - is off by that
much unless you rebase. Addresses in this module are flash addresses.

**It uses WCH's "XW" compressed opcodes.** The MCU is a QingKe RV32IMAC core,
whose XW extension adds `c.lbu` / `c.sb` / `c.lhu` / `c.sh` in the encoding
space the D extension would have used. Capstone has no idea, and renders them
as `c.fld` / `c.fsd` with a nonsense offset - which matters, because a keyboard
firmware is almost entirely byte loads and stores. `xw()` below decodes them.
"""
import re
import struct
import sys

import capstone

REG = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1',
       'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
       's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6']


def _rc(n):
    """The 3-bit compressed register field: 0 is s0, 7 is a5."""
    return REG[8 + n]


def xw(h):
    """Decode one WCH XW compressed load/store halfword, or None.

        c.lbu  001 uimm[0] uimm[4:3] rs1' uimm[2:1] rd'  00
        c.sb   101 uimm[0] uimm[4:3] rs1' uimm[2:1] rs2' 00
        c.lhu  001 uimm[5:3]         rs1' uimm[2:1] rd'  10
        c.sh   101 uimm[5:3]         rs1' uimm[2:1] rs2' 10

    Byte offsets reach 31, halfword offsets 62 - wider than ratified Zcb, which
    is why gcc emits them so freely here.
    """
    quadrant, funct3 = h & 3, (h >> 13) & 7
    if funct3 not in (1, 5):
        return None
    b12, b11, b10 = (h >> 12) & 1, (h >> 11) & 1, (h >> 10) & 1
    b6, b5 = (h >> 6) & 1, (h >> 5) & 1
    rs1, rd = _rc((h >> 7) & 7), _rc((h >> 2) & 7)
    if quadrant == 0:
        offset = b12 | b11 << 4 | b10 << 3 | b6 << 2 | b5 << 1
        name = 'c.lbu' if funct3 == 1 else 'c.sb'
    elif quadrant == 2:
        offset = b12 << 5 | b11 << 4 | b10 << 3 | b6 << 2 | b5 << 1
        name = 'c.lhu' if funct3 == 1 else 'c.sh'
    else:
        return None
    return name, '%s, %d(%s)' % (rd, offset, rs1)


class Insn:
    __slots__ = ('address', 'size', 'mnemonic', 'op_str')

    def __init__(self, address, size, mnemonic, op_str):
        self.address, self.size = address, size
        self.mnemonic, self.op_str = mnemonic, op_str

    def __repr__(self):
        return '%06x  %-9s %s' % (self.address, self.mnemonic, self.op_str)


def extract(exe_path):
    """Pull resource BIN/134 - the firmware image - out of the updater."""
    data = open(exe_path, 'rb').read()
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    optsz = struct.unpack_from('<H', data, pe + 20)[0]
    base = struct.unpack_from('<II', data, pe + 120 + 8 * 2)[0]  # resource directory
    off = pe + 24 + optsz
    sections = []
    for _ in range(struct.unpack_from('<H', data, pe + 6)[0]):
        vsz, va, rsz, raw = struct.unpack_from('<IIII', data, off + 8)
        sections.append((va, vsz, raw, rsz))
        off += 40

    def to_off(rva):
        for va, vsz, raw, rsz in sections:
            if va <= rva < va + max(vsz, rsz):
                return raw + (rva - va)
        raise KeyError(hex(rva))

    def walk(rva, path):
        o = to_off(rva)
        named, ids = struct.unpack_from('<HH', data, o + 12)
        for i in range(named + ids):
            name_id, entry = struct.unpack_from('<II', data, o + 16 + 8 * i)
            if name_id & 0x80000000:
                no = to_off(base + (name_id & 0x7fffffff))
                n = struct.unpack_from('<H', data, no)[0]
                label = data[no + 2:no + 2 + n * 2].decode('utf-16le')
            else:
                label = name_id
            if entry & 0x80000000:
                found = walk(base + (entry & 0x7fffffff), path + [label])
                if found:
                    return found
            elif path[:1] == ['BIN']:
                rva_, size = struct.unpack_from('<II', data, to_off(base + entry))[:2]
                return data[to_off(rva_):to_off(rva_) + size]
        return None

    blob = walk(base, [])
    if blob is None:
        raise SystemExit('%s carries no BIN resource - is this the updater?' % exe_path)
    return blob


class FW:
    """The firmware image, addressed the way the code addresses itself."""

    BASE = 0x5000

    def __init__(self, path):
        raw = open(path, 'rb').read()
        self.b = extract(path) if raw[:2] == b'MZ' else raw
        self.lo, self.hi = self.BASE, self.BASE + len(self.b)
        self.md = capstone.Cs(capstone.CS_ARCH_RISCV,
                              capstone.CS_MODE_RISCV32 | capstone.CS_MODE_RISCVC)
        self._ins = None

    # --- reading -----------------------------------------------------------
    def byte(self, a):
        return self.b[a - self.BASE]

    def half(self, a):
        return struct.unpack_from('<H', self.b, a - self.BASE)[0]

    def word(self, a):
        return struct.unpack_from('<I', self.b, a - self.BASE)[0]

    def f32(self, a):
        return struct.unpack_from('<f', self.b, a - self.BASE)[0]

    def bytes(self, a, n):
        return self.b[a - self.BASE:a - self.BASE + n]

    def strings(self, minlen=5):
        return [(m.start() + self.BASE, m.group().decode('latin1'))
                for m in re.finditer(rb'[ -~]{%d,}' % minlen, self.b)]

    # --- disassembly -------------------------------------------------------
    def at(self, a):
        h = struct.unpack_from('<H', self.b, a - self.BASE)[0]
        decoded = xw(h)
        if decoded:
            return Insn(a, 2, decoded[0], decoded[1])
        for i in self.md.disasm(self.b[a - self.BASE:a - self.BASE + 8], a, count=1):
            return Insn(a, i.size, i.mnemonic, i.op_str)
        return Insn(a, 2, '.half', '0x%04x' % h)

    def ins(self):
        """Linear sweep from the image start. Good enough here: this compiler
        leaves no data in .text, and spot checks land on real boundaries."""
        if self._ins is None:
            self._ins, a = {}, self.BASE
            while a < self.hi - 2:
                i = self.at(a)
                self._ins[a] = i
                a += i.size
        return self._ins

    BRANCH = {'beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'beqz', 'bnez', 'j',
              'jal', 'c.j', 'c.jal', 'c.beqz', 'c.bnez'}

    def target(self, i):
        if i.mnemonic not in self.BRANCH or not i.op_str:
            return None
        try:
            return i.address + int(i.op_str.split(', ')[-1], 0)
        except ValueError:
            return None

    def dis(self, start, n=40, end=None):
        out, a = [], start
        while (end is None and len(out) < n) or (end is not None and a < end):
            i = self.at(a)
            tgt = self.target(i)
            out.append('%06x  %-9s %-26s%s'
                       % (a, i.mnemonic, i.op_str, '   -> %06x' % tgt if tgt else ''))
            a += i.size
        return '\n'.join(out)

    def func_start(self, a):
        p = a
        while p > self.BASE:
            p -= 2
            i = self.at(p)
            if i.mnemonic in ('c.addi16sp', 'c.addi') and i.op_str.startswith('sp, -'):
                return p
            if i.mnemonic == 'addi' and i.op_str.startswith('sp, sp, -'):
                return p
        return self.BASE

    def callers(self):
        out = {}
        for a, i in self.ins().items():
            if i.mnemonic in ('jal', 'c.jal'):
                t = self.target(i)
                if t is not None and self.lo <= t < self.hi:
                    out.setdefault(t, []).append(a)
        return out


def open_default():
    """The updater in its usual place, or a path given on the command line."""
    return FW(sys.argv[1] if len(sys.argv) > 1 else 'Raven FW/FW.exe')

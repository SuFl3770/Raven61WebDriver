"""Minimal PE32 reader: sections, imports, RVA<->file offset. No dependencies."""
import struct


class PE:
    def __init__(self, path):
        self.data = open(path, 'rb').read()
        d = self.data
        pe = struct.unpack_from('<I', d, 0x3c)[0]
        self.pe = pe
        self.machine, self.nsec = struct.unpack_from('<HH', d, pe + 4)
        self.optsz = struct.unpack_from('<H', d, pe + 20)[0]
        self.magic = struct.unpack_from('<H', d, pe + 24)[0]
        assert self.magic == 0x10b, 'PE32 only'
        self.image_base = struct.unpack_from('<I', d, pe + 52)[0]
        ndirs = struct.unpack_from('<I', d, pe + 116)[0]
        self.dirs = [struct.unpack_from('<II', d, pe + 120 + 8 * i) for i in range(ndirs)]
        off = pe + 24 + self.optsz
        self.sections = []
        for _ in range(self.nsec):
            name = d[off:off + 8].rstrip(b'\0').decode('latin1')
            vsz, va, rsz, rp = struct.unpack_from('<IIII', d, off + 8)
            self.sections.append({'name': name, 'va': va, 'vsize': vsz, 'raw': rp, 'rsize': rsz})
            off += 40

    def rva_to_off(self, rva):
        for s in self.sections:
            if s['va'] <= rva < s['va'] + max(s['vsize'], s['rsize']):
                return s['raw'] + (rva - s['va'])
        return None

    def off_to_rva(self, off):
        for s in self.sections:
            if s['raw'] <= off < s['raw'] + s['rsize']:
                return s['va'] + (off - s['raw'])
        return None

    def section(self, name):
        return next(s for s in self.sections if s['name'] == name)

    def cstr(self, off):
        end = self.data.index(b'\0', off)
        return self.data[off:end].decode('latin1')

    def imports(self):
        """{"dll!function": IAT slot VA}"""
        rva, _size = self.dirs[1]
        out = {}
        off = self.rva_to_off(rva)
        while True:
            oft, _, _, name_rva, first_thunk = struct.unpack_from('<IIIII', self.data, off)
            if oft == 0 and first_thunk == 0:
                break
            dll = self.cstr(self.rva_to_off(name_rva))
            t_off = self.rva_to_off(oft or first_thunk)
            i = 0
            while True:
                entry = struct.unpack_from('<I', self.data, t_off + 4 * i)[0]
                if entry == 0:
                    break
                if not entry & 0x80000000:
                    fn = self.cstr(self.rva_to_off(entry) + 2)
                    out[f'{dll}!{fn}'] = self.image_base + first_thunk + 4 * i
                i += 1
            off += 20
        return out

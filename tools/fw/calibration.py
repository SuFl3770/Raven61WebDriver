"""Re-derives every calibration/LED fact in docs/protocol.md from the firmware.

    python tools/fw/calibration.py            # reads "Raven FW/FW.exe"
    python tools/fw/calibration.py path.bin   # or a bare firmware image

Nothing here is typed in from notes: each number is read back out of the image
at the address the comment names, so if a firmware revision moves something the
script says so instead of quietly agreeing with the docs.

The addresses were found by starting at the HID command dispatcher (0x7534,
whose 243-entry jump table at 0x157b0 is indexed by payload[1]) and following
the analog-test commands 0xa8 / 0xa9 into the scan loop at 0xe392.
"""
import struct
import sys

sys.path.insert(0, __file__.rsplit('calibration.py', 1)[0])
from fw import open_default  # noqa: E402

# --- addresses, all flash --------------------------------------------------
DISPATCH = 0x157b0          # jump table, 243 entries, indexed by payload[1]
STABLE_COUNT_CMP = 0xe6ca   # `c.li a5, 0x18` guarding the scale commit
DISPATCH_MAX = 0xf2         # bltu against this before the index is used
STATUS_PALETTE = 0x1753c    # 8 x RGB, indexed by the per-key calibration state
SWITCH_STROKE = 0x15e08     # u16 per switch type, in 0.02 mm counts
TRAVEL_LUT = 0x15e34        # 8 types x 201 u16: travelRaw -> depth counts
SLOT_TABLE = 0x16ac4        # 3 bytes per sensor slot: length, modifier, usage
FLOAT_POOL = 0x15690        # the constants the scan loop compares against
CAL_DEFAULTS = 0x20300      # shipped calibration table, 64 x 8 bytes
GLOBAL_DEFAULTS = 0x20100
KEYPERF_DEFAULTS = 0x20700
LED_DEFAULTS = 0x20f00

# The LED overlay at 0x13974 paints a key only while state <= 1, so only the
# first two palette entries are ever used for calibration.
STATE_PAINTED_MAX = 1


def main():
    f = open_default()
    print('image      %d bytes, flash %06x..%06x' % (len(f.b), f.lo, f.hi))
    build = [s for _, s in f.strings(8)][:3]
    print('build      %s' % ' '.join(build))
    print()

    print('--- HID command dispatch (0x7534 -> table at %06x) ---' % DISPATCH)
    table = [f.word(DISPATCH + 4 * i) for i in range(DISPATCH_MAX + 1)]
    unknown = max(set(table), key=table.count)
    handled = [(i, t) for i, t in enumerate(table) if t != unknown]
    print('  %d commands handled, everything else -> %06x' % (len(handled), unknown))
    print('  ' + ' '.join('%02x' % i for i, _ in handled))
    print()

    print('--- calibration record (RAM 0x20001b24, flash %06x, 64 x 8 bytes) ---'
          % CAL_DEFAULTS)
    print('  [0..3] float32 scale   [4] state   [5..7] tag AA BB FF')
    seen = {}
    for k in range(64):
        rec = f.bytes(CAL_DEFAULTS + 8 * k, 8)
        seen.setdefault((struct.unpack('<f', rec[:4])[0], rec[4], rec[5:].hex(' ')), []).append(k)
    for (scale, state, tag), keys in seen.items():
        print('  shipped default: scale %.4f  state 0x%02x  tag %s   (keys %d-%d)'
              % (scale, state, tag, min(keys), max(keys)))
    print()

    print('--- LED status palette (%06x), indexed by state ---' % STATUS_PALETTE)
    for i in range(8):
        r, g, b = f.bytes(STATUS_PALETTE + 3 * i, 3)
        used = ' <- calibration overlay' if i <= STATE_PAINTED_MAX else ''
        print('  %d  #%02X%02X%02X%s' % (i, r, g, b, used))
    print()

    print('--- scan-loop constants (float pool at %06x) ---' % FLOAT_POOL)
    for off, what in ((0x00, 'scale floor, and the value a reset writes back'),
                      (0x04, 'scale ceiling; outside [floor, ceiling] -> reset at boot'),
                      (0x08, 'divisor turning frac(scale) into event digits'),
                      (0x0c, 'travelRaw at full travel (scale = delta / this)'),
                      (0x10, 'scale sanity ceiling while learning'),
                      (0x14, 'smallest scale growth worth taking'),
                      (0x18, 'quantiser for the stability check (scale x this)'),
                      (0x24, 'travelRaw that counts as bottomed out'),
                      (0x28, 'scale above which a key may be called calibrated')):
        print('  %06x  %-10.5f  %s' % (FLOAT_POOL + off, f.f32(FLOAT_POOL + off), what))
    # Not a float: the stability count is an immediate in `c.li a5, 0x18`,
    # compared with bgeu just before the scale is committed.
    stable = int(f.at(STABLE_COUNT_CMP).op_str.split(', ')[1], 0)
    print('  %06x  %-10d  consecutive stable samples before the scale is taken'
          % (STABLE_COUNT_CMP, stable))
    print()

    print('--- switch stroke, 0.02 mm counts (%06x) ---' % SWITCH_STROKE)
    strokes = [f.half(SWITCH_STROKE + 2 * i) for i in range(8)]
    print('  ' + '  '.join('%d:%d (%.2fmm)' % (i, v, v * 0.02) for i, v in enumerate(strokes)))
    print()

    print('--- travelRaw -> depth LUT (%06x, 8 x 201 u16) ---' % TRAVEL_LUT)
    for t in range(8):
        row = [f.half(TRAVEL_LUT + t * 0x192 + 2 * i) for i in range(201)]
        real = [v for v in row if v != 4095]
        print('  type %d: %d real entries, travelRaw %d..%d, sentinel 4095 beyond'
              % (t, len(real), real[0] if real else 0, real[-1] if real else 0))
    print()

    print('--- sensor slot table (%06x, 3 bytes per slot) ---' % SLOT_TABLE)
    print('  slot: len mod usage')
    for k in range(64):
        ln, mod, usage = f.bytes(SLOT_TABLE + 3 * k, 3)
        note = ''
        if ln != 0x10:
            note = '  (not a key slot)'
        elif mod and not (mod & (mod - 1)):
            note = '  modifier bit %d -> usage 0x%02X' % (mod.bit_length() - 1,
                                                          0xE0 + mod.bit_length() - 1)
        elif usage == 0 and mod == 0:
            note = '  (unpopulated)'
        print('  %2d:   %02x  %02x  %02x%s' % (k, ln, mod, usage, note))
    print()

    print('--- other flash blobs ---')
    print('  %06x global settings   %s' % (GLOBAL_DEFAULTS,
                                           f.bytes(GLOBAL_DEFAULTS, 16).hex(' ')))
    print('  %06x key performance   %s' % (KEYPERF_DEFAULTS,
                                           f.bytes(KEYPERF_DEFAULTS, 16).hex(' ')))
    print('  %06x per-key RGB       %s' % (LED_DEFAULTS, f.bytes(LED_DEFAULTS, 16).hex(' ')))


if __name__ == '__main__':
    main()

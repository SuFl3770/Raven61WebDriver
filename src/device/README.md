# Adding a keyboard

This app talks to one *protocol family*: the 64-byte vendor framing recovered
from the Raven driver, with block transfers, an 8-byte per-key performance
record and a 3-byte keymap record. Everything that is specific to a *board* —
USB ids, command numbers, block sizes, bit positions, the key table, the switch
list — is data, and lives in a `DeviceSpec`.

So supporting another keyboard of that family is writing one value. No file in
`src/protocol` and no panel in `src/features` has to change.

```
src/device/
  spec.ts        the shape of a definition, field by field
  define.ts      defineDevice(): state your differences, inherit the rest
  validate.ts    what a JSON definition is checked against
  registry.ts    every known board; codecs are built from specs here
  active.ts      which board the UI is currently laid out for
  layout.ts      key-table lookups, built per spec
  tables.ts      the active board's switch and report-rate lists
  forced.ts      ⚠ debug only: the default protocol on an unclaimed device
  protocols/
    default.ts   the baseline every definition inherits — a copy of Raven61's
  boards/
    index.ts     the list; add yours here
    raven61/
      index.ts   what the hardware is: ids, rates, layers
      protocol.ts  how it talks: framing, commands, block geometry, timings
      layout.json    its key table (generated — do not hand-edit)
      layout.ts      that table, typed — and what each column means
      switches.json  the switches it takes: travel, magnet, colour
      switches.ts    that table, typed — and where its numbers came from
  user/          your boards (JSON) — see user/README.md
```

One board is one folder, and inside it the two questions are separate files:
**`protocol.ts` is how it talks, `index.ts` is what it is.** They have different
evidence behind them and a board can share one without sharing the other — which
is exactly what `protocols/default.ts` is: a copy of the Raven61's protocol,
with none of its identity.

The two tables that grow — the key table and the switch table — get files of
their own beside those, for the same reason: they are lists about *parts*, they
gain a column whenever somebody measures something new, and neither is
something you want to scroll past to find out which USB id a board answers on.

Each of those is a **pair**: `<table>.json` holds the rows, `<table>.ts` gives
them a type and carries the prose. JSON cannot hold a comment and both tables
are mostly footnotes, so the notes live next door rather than nowhere; the JSON
stays something a generator can overwrite and a diff can be read. Both are the
same shape as the matching field of a `user/*.device.json`, so rows copy either
way, and `tools/check/device-spec.ts` runs both through the validator a user's
JSON gets — which is what catches the one mistake the compiler cannot see, a
misspelt field name.

There is **no runtime importer and no upload button**: a definition decides what
bytes get written to someone's keyboard, so it belongs in the source tree, where
it can be read and kept. Adding a board means editing this directory and
running the build.

## Two ways in

### TypeScript — `src/device/boards/<board>/`

Type-checked, and the only way to express something the JSON schema cannot.

```ts
import { defineDevice } from '../define'
import { RAVEN68_LAYOUT } from './raven68.layout'

export const raven68Spec = defineDevice({
  id: 'raven68-v1',
  name: 'Raven68',
  confidence: 'guess',
  // Required, and a claim about hardware: "I have checked that this board
  // answers the Raven61's protocol." Everything inherited below rests on it.
  basedOn: 'raven61-v1',
  usb: { vendorId: 0x19f5, productIds: [0xfe20] },
  layout: RAVEN68_LAYOUT,
  // Everything below is optional: what you leave out is inherited.
  commands: { factoryReset: null },
})
```

A board whose protocol was decoded on its own uses `defineIndependentDevice`
instead, which takes a complete spec and inherits nothing.

Then add it to `BUILT_IN_SPECS` in `specs/index.ts`. That is the whole
registration step.

### JSON — `src/device/user/<board>.device.json`


The same shape as a plain object. Files there are bundled at build time,
validated at startup, and registered before the first render. A file that fails
validation is skipped with its errors on the console; the rest of the app, and
every other board, still loads. See [`user/README.md`](user/README.md) for a
template.

## What you must supply, and what you inherit

Required either way:

| field | why it cannot be inherited |
| --- | --- |
| `id` | what the app stores and logs |
| `name` | what it shows |
| `confidence` | `confirmed` / `partial` / `guess` / `none` — the badge that tells a user whether to trust a write. Inheriting it would let a board that has never been plugged in claim someone else's testing. |
| `usb` | vendor id, and the product ids it enumerates as — matched **exactly** |
| `basedOn` | whose protocol you are claiming to inherit (`defineDevice` / JSON only) |
| `layout` | the key table: this is what makes a board that board |

Everything else — framing, command numbers, block geometry, the global-settings
offsets, the analog event layout, timings — falls back to the Raven61's, which
is the only board in this family whose numbers have evidence behind them.
Inheritance is **per leaf**: naming one command leaves the other thirteen alone.

## The protocol is not assumed to be shared

One board's protocol has been decoded, on one unit. There is no evidence that
any other keyboard — including the vendor's own siblings — answers the same
bytes, so this app refuses to act as if there were:

- **Product ids are matched exactly.** A connected device that no spec lists
  gets `unknownCodec`, which implements nothing: no read, no write, no analog
  mode. The panels show their "not decoded" state and the key grid says there
  is no definition for the device, rather than drawing a placeholder board.
  There is no "any product of this vendor" option to turn on.
- **Inheriting a protocol is an explicit claim.** `basedOn` is required, both in
  TypeScript and in JSON, and it is kept on the spec afterwards so the claim has
  an owner.
- The Raven61 spec itself lists **one** product id, `0xFED0` — the one its own
  firmware image reports. The other two ids in the stock driver are almost
  certainly its siblings, and are deliberately not claimed.

## Working out the numbers

In the order that stops you wasting effort:

1. **USB ids and the key table.** The layout generator turns a vendor XML into
   a table: `node tools/layout/from-vendor-xml.mjs <Board>.xml
   src/device/boards/<board>/layout.json`. Without a vendor file, write the rows
   by hand — `index` must be the row's own position, `code` the key's default
   HID usage (decimal, JSON having no hex), and `keyIndex` the firmware's key
   address.
2. **Framing.** Watch one exchange (the Debug tab's traffic log, or a capture).
   If the requests start `55 <cmd>` in a 64-byte report with the checksum at
   byte 3, you inherit the whole `frame` section.
3. **Commands.** Which byte reads the per-key block, which writes it, which
   enters analog test mode. Anything you have not confirmed goes in as `null` —
   the codec is then built without that capability and the panel says so,
   instead of sending a byte that means something else on your board.
4. **Block geometry.** How many slots the per-key block has, how wide a keymap
   layer is, how wide a colour record is. A wrong size here reads short or
   writes off the end.
5. **The tables.** `switchTypes` (a built-in board keeps it in
   `switches.json`, loaded by the `switches.ts` beside it)
   and `reportRates` are per board; the defaults are the Raven61's list and
   will show the wrong switch names on anything else. Only `value` and
   `travelMm` matter to the protocol — `travelMm` is what every millimetre in
   the app is divided by, so it is worth getting from the switch's own spec
   sheet. `vendor`, `magnetGauss` and `color` are description, shown in the
   switch panel and used nowhere else; leave any of them out when you do not
   know it, and the panel prints "—" or nothing at all instead of a guess.

Set `confidence` to match how far you actually got. `guess` is not an insult —
it is what the UI shows the user before they let it write to their keyboard.

## The vendor's own profile file

A board may also declare `stockProfile`, which says *the driver that shipped
with this keyboard writes a profile file, and here is what is in it*. The app
then offers "save as stock XML" alongside its own JSON, and opens such a file
when one is picked.

**It is not inherited, and that is deliberate.** Everything else in this
baseline is a fact about hardware that a sibling plausibly shares; this is a
fact about *another piece of software*. A board that inherited the Raven61's
would offer to write a file stamped `pro_name="Raven61 HE"` carrying its ten
macro slots and its layer list, and the stock driver would read that back onto a
keyboard it does not describe. So a board claims it by stating it, once someone
has an export from that board and has looked inside.

Leaving it out is the normal case and costs nothing: the app's own JSON format
is this app's model written down, it works on every board, and it is the one
format that drops nothing. `src/device/user/example.device.json.sample` has the
field spelled out; `src/profile/stock.ts` says what the format can and cannot
hold.

## What a spec may *not* change

The record layouts. The 8-byte performance record's bit packing and the 3-byte
keymap record are the family's, recovered from the stock driver's encoder and
decoder being exact inverses. The 3-byte colour record is the family's too, and
for a stronger reason: the firmware's LED path loads its bytes straight into the
R, G and B registers, so there is no encoding to differ over — only `recordSize`
and `slots`, which is all `keyRgb` holds. A board that packs them differently is not a spec
change: it needs its own `KeyboardCodec` (see `src/protocol/codec.ts`), which
registers the same way.

## First contact with a board nobody has decoded

There is a debug-only switch for the moment before a definition exists: connect
the board, open the **interface** panel (five taps of Shift turns the debug
tabs on), and *Force the default protocol*. The app then speaks the default
protocol to a device no definition claims, so you can see whether it answers at
all.

- ⚠ **The commands are another keyboard's.** A read that goes unanswered costs
  nothing; a write on hardware that does not share this protocol is undefined,
  and `0xa1` here writes a whole configuration block. Keep the traffic log open
  and start with reads.
- The key grid it draws is the placeholder board's, not that device's.
- It is not persisted and it clears on disconnect. Forcing every session is not
  support — a board that answers is a board worth writing a definition for.

## Checking your work

`npm run check` includes `tools/check/device-spec.ts`, which builds a codec for
a small invented board and asserts it addresses that board's offsets — plus
every refusal the JSON validator is supposed to make. If you add a board and the
suite still passes, the plumbing is right; whether the *numbers* are right is
what your keyboard tells you.

# Your own boards

Drop a `<name>.device.json` in this directory and rebuild (`npm run dev` or
`npm run build`). Everything matching `*.device.json` here is bundled,
validated and registered before the first render.

`example.device.json.sample` next to this file is a working definition — copy it
to `my-board.device.json` and edit. The `.sample` suffix is what keeps it out of
the glob, so the example itself never claims a device.

Nothing in this directory is git-ignored: a definition is source, and the point
of keeping it here is that it can be reviewed and kept alongside the code that
sends its bytes.

## The short version

```json
{
  "id": "my-board-v1",
  "name": "My Board",
  "confidence": "guess",
  "basedOn": "raven61-v1",
  "usb": { "vendorId": 4085, "productIds": [65232] },
  "layout": {
    "units": { "width": 15, "height": 5 },
    "travelMm": 4.0,
    "keys": [
      { "index": 0, "label": "Esc", "code": 41, "x": 0, "y": 0, "w": 1, "keyIndex": 16, "lightIndex": 16 }
    ]
  }
}
```

Every other section is optional and falls back to the Raven61's — see
[`../README.md`](../README.md) for what that means and how to work out the
numbers that differ.

Four things worth knowing before your first build (JSON has no comments, but a
key starting with `//` is treated as one and ignored, so you can annotate the
file):

- **`basedOn` is a claim, not boilerplate.** Everything this file leaves out —
  the framing, the command bytes, the block sizes, the record layout — is the
  Raven61's, and nothing in this app can check that your board agrees. Setting
  it says you have confirmed that it does. It is required, and a file without
  it is refused.
- **Product ids are matched exactly.** A device whose id is not in your list
  gets no codec: the app will not decide that an unlisted board is probably a
  sibling. That is deliberate — the vendor here ships several models, and only
  one of them has been tested.
- **JSON has no hex.** `0x19f5` is `6645`. Getting this wrong means the spec
  claims a device that is not yours, so check it against the id the Debug tab's
  interface panel shows.
- **A command you have not confirmed goes in as `null`**, not as a guess. The
  codec is then built without that capability and the panel says the board does
  not support it — which is true, as far as anyone here knows, and far better
  than sending a byte that means something else on your hardware.

## When it does not load

Open the browser console. A rejected file names itself and the field:

```
device spec rejected — my-board.device.json: commands.readKeyPerf must be a byte, 0-255
```

The app keeps running, and every other board still loads. A file that validates
but claims an `id` another spec already uses is skipped the same way, with the
first one kept.

import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { useDeviceSpec } from '../device/active'
import { layerName } from '../protocol/layers'
import { useDirtyKeys } from '../state/config'
import { suppressDebugGesture } from '../state/debugGesture'
import { useLayerKeymap } from '../state/legends'
import type { KeymapEntry } from '../protocol/types'
import { useConnection } from '../state/link'
import { useSettings } from '../state/settings'
import { boardSync } from '../state/sync'
import { GridFrame } from '../ui/GridFrame'
import { KeyGrid } from '../ui/KeyGrid'
import { SubTabs, type SubTab } from '../ui/SubTabs'
import { AdvancedInUseSection, useAdvancedSnapshot } from './AdvancedInUse'
import { KeyInfo } from './KeyInfo'
import { PerfOverview } from './PerfOverview'

/**
 * What the board currently has, read back rather than set.
 *
 * Nothing here writes. Every section is a table of what a tab elsewhere put on
 * the board, named after the tab it answers for — so "input point" is the table
 * for the input-point tab and "advanced keys" for its neighbour, and the ones
 * still to come will each answer for one more.
 *
 * Both sections arrived the same way: each was the one section of its own tab
 * that edited nothing, sitting on a strip where everything else opened an
 * editor. Read-only readouts on a strip of editors read as a landing page for
 * the tab rather than as a report on it — and gathered here they are a page
 * someone can open to ask what the board is set to, without going tab by tab.
 */

/**
 * The sections, named after the tab each one answers for.
 *
 * Built per render rather than declared once, because both of them are handed
 * something that changes under them — the debug flag, and the advanced-key read
 * the tab owns — and a list frozen at module load would hold the first value it
 * ever saw.
 */
function sectionsFor(
  debug: boolean,
  advanced: ReturnType<typeof useAdvancedSnapshot>,
  layer: number,
  keymap: readonly (KeymapEntry | undefined)[] | null,
  picked: number | null,
  onPick: (index: number) => void,
): SubTab[] {
  return [
    {
      // First, because it is the question with a key already in mind — the two
      // below are for reading the board over, which is what you do once this
      // one has not answered it.
      id: 'keys',
      labelKey: 'overview.section.keys',
      render: () => (
        <KeyInfo
          picked={picked}
          onPick={onPick}
          layer={layer}
          keymap={keymap}
          advanced={advanced}
        />
      ),
    },
    {
      id: 'input',
      labelKey: 'overview.section.input',
      render: () => <PerfOverview />,
    },
    {
      id: 'advanced',
      labelKey: 'overview.section.advanced',
      // The two protocol columns follow the app's debug mode, the same as they
      // did on the tab this table came from — see features/AdvancedInUse.
      render: () => <AdvancedInUseSection read={advanced} layer={layer} debug={debug} />,
    },
  ]
}

export function Overview() {
  const { connected, device } = useConnection()
  const { debug } = useSettings()
  const spec = useDeviceSpec()
  const dirty = useDirtyKeys()
  const t = useT()
  /*
   * Which layer this tab is reporting on.
   *
   * Owned here rather than by a section, because the grid follows it and the
   * grid is the tab's, not a section's: the caps read what each key sends on
   * this layer and carry that layer's advanced-key bands. The strip, the
   * legends, the bands and the table are one answer or they are four.
   */
  const [layer, setLayer] = useState(0)
  /*
   * That layer's keymap, or null on the base layer, where the shared store
   * already holds it — see state/legends.ts. Null is also what the grid gets
   * while a layer is still being read, and it falls back to the store rather
   * than to blank caps.
   */
  const keymap = useLayerKeymap(layer)
  // Read once for the tab, not once per section — the grid and the advanced
  // section both draw out of it. See useAdvancedSnapshot.
  const advanced = useAdvancedSnapshot()
  /*
   * The cap the key-info section is about.
   *
   * Local, not the shared selection store: that store is what the tabs which
   * write act on, and a pick made here would follow the reader onto one of
   * them and quietly widen what the next write covers. Nothing on this tab
   * writes, so nothing here needs to be in it.
   */
  const [picked, setPicked] = useState<number | null>(null)
  /*
   * Picking the key that is already picked puts it down.
   *
   * The same gesture either way: pressing a key again, or clicking its cap
   * again. A section whose only control is "choose a key" needs a way back to
   * choosing none, and a separate clear button would be a second control for
   * the inverse of the first.
   *
   * `useCallback` with the updater form, so the identity never changes — the
   * press listener holds it in a dependency, and a new function every render
   * would tear the window's listener down and put it back on every keystroke.
   */
  const pickKey = useCallback((index: number) => {
    setPicked((current) => (current === index ? null : index))
  }, [])
  const sections = sectionsFor(debug, advanced, layer, keymap, picked, pickKey)
  const [active, setActive] = useState(sections[0]!.id)
  /*
   * Caps are clickable only where a click means something. On the two table
   * sections there is nothing a picked key would change, and a grid that
   * highlights under the pointer while the page below stays put is a control
   * that looks broken.
   */
  const picking = active === 'keys'

  /*
   * No debug gesture while this tab is open.
   *
   * The key-info section takes the next keystroke as "which key do you mean",
   * and Shift is a key it can be asked about — so five taps of it here are
   * somebody inspecting the Shift key, not asking for the protocol lab. The
   * whole tab rather than that one section: the sections share a grid and a
   * reader moving between them is doing one thing, and a gesture that worked
   * on two sections out of three would be a gesture nobody could describe.
   */
  useEffect(() => suppressDebugGesture(), [])

  /*
   * Opening a section reads the board — the same rule as the input-point tab,
   * and the reason the sections themselves do not read on mount. A report on
   * what the board holds is worth nothing if it is showing what the board held
   * when some other tab last looked. The read is skipped while edits are still
   * on their way out — see boardSync.read.
   */
  useEffect(() => {
    if (!connected) return
    void boardSync.read()
  }, [active, connected])

  /*
   * A pick belongs to the section it was made in.
   *
   * The grid stays put across a section change but only one section acts on
   * what is picked in it, so a cap left selected while the tables are open is
   * a highlight nothing on screen explains — and coming back to find the panel
   * still answering about a key chosen several sections ago is an answer to a
   * question nobody is still asking. The same rule App.tsx applies to the
   * selection store when the sidebar's tabs change.
   */
  useEffect(() => setPicked(null), [active])

  /*
   * What the strip shows as chosen, which is not always what is open.
   *
   * The key-info section with no key picked is the tab's resting state: it
   * greets rather than reports, and nothing has been asked of it yet. A lit
   * button over that would be claiming a section is open when what is on
   * screen is the page you land on — so the strip shows nothing chosen until a
   * key is picked, and goes back to nothing when it is put down again.
   *
   * An id no tab has, rather than a second prop: `SubTabs` already falls back
   * to its first section when `active` matches nothing, and that first section
   * is this one.
   */
  const stripActive = active === 'keys' && picked === null ? '' : active

  /**
   * Which advanced key each cap runs on the open layer, for the bands.
   *
   * A use with no key index is one the slot map could not place — it belongs to
   * no cap on this layout, so there is no band to draw for it. The table below
   * still lists it, under its slot number.
   */
  const byKey = new Map(
    advanced.snapshot?.uses
      .filter((u) => u.layer === layer && u.index >= 0)
      .map((u) => [u.index, u.kind] as const) ?? [],
  )

  return (
    <>
      {/*
        `selectable={false}`, so the frame draws the caps and nothing else — no
        select-all, no selection count. Nothing on this tab acts on a selection,
        and the selection store is shared with the tabs that write, so painting
        caps here would silently change what one of them is pointing at.

        What the foot says instead is how much to trust the tables below: which
        keyboard they cover, how old the read is, and whether the app is holding
        edits the board has not been sent. That last one is the whole caveat of
        a report tab — the tables show what the app has, and while a write is
        queued that is not the same as what the board has. It stays under the
        grid rather than inside a section because it is true of every section,
        including the ones not written yet, and because the band does not scroll
        away when the table below it does.
      */}
      <GridFrame
        selectable={false}
        top={
          /*
            The same section strip the remap and advanced-key tabs give their
            layers, in the same place — see the comment on the strip there.

            On every section, not only the one that lists per-layer settings.
            Most of what this tab reports is one global copy — actuation, rapid
            trigger, dead zones and switch types do not change with the layer
            (see protocol/layers.ts) — but the grid above every section does,
            because what a cap sends is a keymap entry. A strip that came and
            went with the section would be a control moving in and out of the
            bar while the thing it acts on stayed put.
          */
          <div className="layer-tabs" role="tablist" aria-label={t('keymap.layers')}>
            {Array.from({ length: spec.keymap.layers }, (_, i) => (
              <button key={i} role="tab" aria-selected={i === layer} onClick={() => setLayer(i)}>
                {layerName(i)}
              </button>
            ))}
          </div>
        }
        foot={
          <>
            {/*
              Which keyboard this is, as its firmware introduces itself — the
              same name the rail's card carries. The key count used to sit here
              and said less: every grid in the app draws the whole board, so
              "87 keys" was a fact about the picture directly above it rather
              than about the tables below. On a narrow window the rail is a
              drawer that is shut, and then this is the only thing on screen
              naming what the report is a report *of*.
            */}
            <span>{device?.productName || t('device.unnamed')}</span>
            {/* The warn colour the caps use for an edit that has not gone out
                — see `.gridfoot .pending` in styles.css. */}
            {dirty.length > 0 && (
              <span className="pending">{t('overview.foot.pending', { count: dirty.length })}</span>
            )}
          </>
        }
      >
        {/* The caps carry the open layer's legends and its advanced-key bands,
            which is what makes this grid the same keyboard as the one on the
            tab each section reports for.

            Both are handed over rather than left to the grid's own answers,
            which are the base layer's — see the same two props on the remap and
            advanced-key tabs. Only once each read has landed: until then the
            grid's answer is the better one, and caps that fell back to their
            printing for the length of a read is what pressing the strip would
            otherwise look like. */}
        <KeyGrid
          legends={keymap ?? undefined}
          /* Which layer the names belong to, so that switching the strip fades
             them rather than rewriting eighty-seven caps between two frames —
             the same treatment the remap tab gives its second line. */
          legendKey={String(layer)}
          advanced={advanced.snapshot ? (key) => byKey.get(key.index) : true}
          selected={picking && picked !== null ? new Set([picked]) : undefined}
          onSelect={picking ? pickKey : undefined}
        />
      </GridFrame>

      <SubTabs
        tabs={sections}
        label={t('overview.sections')}
        active={stripActive}
        onActive={setActive}
      />
    </>
  )
}

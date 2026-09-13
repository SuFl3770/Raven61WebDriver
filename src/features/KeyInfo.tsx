import { useEffect } from 'react'
import { useT } from '../i18n'
import { T } from '../i18n/T'
import { activeLayout, useLayout } from '../device/active'
import { switchTypeName } from '../device/tables'
import { usageForCode } from '../keyboard/hostKeys'
import { keycodeLabel } from '../keyboard/keycodes'
import { mmToCounts } from '../protocol/encoding'
import { bindingLabel } from '../protocol/keymap'
import type { KeymapEntry } from '../protocol/types'
import { useKeyConfigs } from '../state/config'
import { legendFor, useLegends } from '../state/legends'
import { useSettings } from '../state/settings'
import { KindChip } from '../ui/KindChip'
import { Panel } from '../ui/Panel'
import { useExitValue } from '../ui/useExit'
import { SwitchSwatch } from '../ui/SwitchSwatch'
import { Argument, rowsOf, type AdvancedRead } from './AdvancedInUse'
import { deadZoneLabel, rtLabel, travelOf } from './PerfOverview'

/**
 * One key, answered in full.
 *
 * The other sections are tables of the whole board, which is the right shape
 * for "is anything set oddly" and the wrong one for "what is *this* key doing".
 * Answering that off the grouped table means finding which group a cap fell
 * into and reading across seven columns; off the per-key table it means finding
 * one row in eighty-seven. So the question gets a section, and the section
 * takes a key rather than giving a list.
 *
 * It gathers rather than reads. Everything here was already fetched by the tab
 * for the sections beside it — the keymap for the open layer, the advanced-key
 * tables, the per-key block — and this is the one place that puts all three
 * against a single cap.
 */

/**
 * Picking a key by pressing it.
 *
 * The grid is still there and clicking a cap still works, but a question about
 * the key under your finger should be answerable with the finger already on it.
 * Pressing the same key again puts it down — `onPick` is a toggle, so the way
 * out of an answer is the gesture that asked for it, whichever of the two was
 * used. See `pickKey` in features/Overview.
 * `KeyboardEvent.code` is turned into the HID usage the board would store and
 * then into one of this layout's keys — see keyboard/hostKeys.ts, which two
 * other callers already use the same way.
 *
 * ### What it swallows, and what it does not
 *
 * The press is an answer to what this section is asking rather than input, so
 * it is stopped — otherwise F5 on a board that has an F5 reloads the page in
 * the middle of the question. But only once it has resolved to a key this board
 * actually has, and never with a modifier held: every browser shortcut worth
 * keeping is a combination, and a section that quietly broke Ctrl+R for as long
 * as it was open would be a worse trade than the one key it swallowed.
 *
 * Bound while this section is on screen and no longer, which is structural
 * rather than a condition — `SubTabs` renders only the open section, so leaving
 * it unmounts this and takes the listener with it.
 *
 * Fn never arrives. The keyboard's own firmware consumes it and no `code`
 * reaches the page, so that one cap can only be picked by clicking it.
 */
/**
 * How long the body takes to leave, which `.keyinfo.closing` in styles.css is
 * what actually draws — see ui/useExit.ts for why the number is in both files.
 */
const EXIT_MS = 160

function usePressToPick(onPick: (index: number) => void): void {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      const usage = usageForCode(e.code)
      if (usage === undefined) return
      const key = activeLayout().byUsage(usage)
      if (!key) return
      e.preventDefault()
      onPick(key.index)
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [onPick])
}

export function KeyInfo({
  picked,
  onPick,
  layer,
  keymap,
  advanced,
}: {
  /** The cap being asked about, by key index, or null before one is picked. */
  picked: number | null
  onPick: (index: number) => void
  /** The layer the tab's strip has open — what "sends" is asked of. */
  layer: number
  /** That layer's keymap, or null on the base layer, where the store holds it. */
  keymap: readonly (KeymapEntry | undefined)[] | null
  advanced: AdvancedRead
}) {
  const { keys } = useLayout()
  const configs = useKeyConfigs()
  const store = useLegends()
  const { debug } = useSettings()
  const t = useT()
  usePressToPick(onPick)
  /*
   * The key that was picked, held for the length of the exit.
   *
   * Putting a key down takes its values with it in the same frame, so the body
   * would go blank and then leave. `useExitValue` keeps the last one until the
   * animation has finished with it — the same arrangement the toasts use.
   */
  const { shown, closing } = useExitValue(picked, EXIT_MS)

  const key = shown === null ? undefined : keys.find((k) => k.index === shown)

  if (!key) {
    // No heading. The greeting is the tab's resting state rather than a section
    // of it — the strip above shows nothing chosen while this is up (see
    // `stripActive` in features/Overview) — and "Key info" over a page with no
    // key on it names a section that is not open.
    return (
      <Panel>
        {/*
          Keyed, and the body below is keyed differently, so that swapping one
          for the other replaces the element instead of relabelling it. Both
          arrive with the same animation, and a CSS animation restarts only when
          the name on the element changes — React reusing one `div` across the
          swap left the arrival silent while the exit, which does change the
          name, played fine.

          The key is the *state*, not the key index. Moving from one cap to the
          next keeps this element, which is the point: the panel is answering
          about a different key, not appearing, and re-running the movement on
          every press while a reader works down a row would be noise.
        */}
        <div key="empty" className="keyinfo-empty">
          {/*
            The tab's front page, for as long as nothing is picked.

            Both strings are the reader's to write — see `keyInfo.welcome` in
            locales/*.json, which carries a placeholder until they are. The body
            goes through `T`, so `<b>`, `<i>` and `<c>` work inside it and the
            sentence stays one translatable string.
          */}
          <p>
            <T k="keyInfo.welcome.body" />
          </p>
          {/* Kept under it: the panel still has to say how to make it do
              anything, and that is an instruction rather than an introduction. */}
          <p className="small dim">{t('keyInfo.pick')}</p>
        </div>
      </Panel>
    )
  }

  const entries = keymap ?? store
  const binding = entries[key.index]?.binding
  const config = configs[key.index]
  // The same legend the grid's cap is carrying, so the face below is a receipt
  // for the pick rather than a second opinion about it — see `legendFor`.
  const legend = legendFor(key, entries, keymap === null)
  const rt = config?.rapidTrigger

  /*
   * The advanced key this cap runs on the open layer, folded the way the
   * in-use table folds it — an RS or SOCD pair is one setting, and reading out
   * half of it beside the key that holds the other half says less than nothing.
   */
  const row = rowsOf(
    advanced.snapshot?.uses.filter((u) => u.layer === layer && u.index === key.index) ?? [],
  )[0]

  return (
    <Panel>
      {/*
        The heading is drawn here rather than handed to `Panel` as a title, so
        that it can arrive and leave with the body under it. Passed as a title
        it is the panel's own child, mounted and unmounted a frame apart from
        this — the words would appear before the cap and cut out while the cap
        was still going.
      */}
      <h2 className={`keyinfo-title${closing ? ' closing' : ''}`}>{t('keyInfo.title')}</h2>
      <div key="picked" className={`keyinfo${closing ? ' closing' : ''}`}>
        <div className="keyinfo-cap">
          <div className={`bigcap${legend.remapped ? ' remapped' : ''}`}>{legend.text}</div>
        </div>

        <dl className="facts keyinfo-facts">
          <dt>{t('keyInfo.key')}</dt>
          <dd>{key.label}</dd>

          {/*
            What the cap sends, on the layer the strip has open. An advanced key
            has no binding left that names anything a person chose — the three
            bytes say which record runs it — so the row below answers instead
            and this one says so rather than reading back a record number.
          */}
          <dt>{t('keyInfo.sends')}</dt>
          <dd className="mono">
            {!binding
              ? '—'
              : binding.kind === 'advanced'
                ? t('keyInfo.viaAdvanced')
                : bindingLabel(binding, keycodeLabel)}
          </dd>

          {row && (
            <>
              <dt>{t('keyInfo.advanced')}</dt>
              <dd>
                <KindChip kind={row.kind} />{' '}
                <Argument row={row} snapshot={advanced.snapshot} inline />
              </dd>
            </>
          )}

          {/*
            The per-key block, which is one global copy — the rows below are the
            same whichever layer the strip has open, unlike the two above.
          */}
          <dt>{t('perf.col.actuation')}</dt>
          <dd className="mono">
            {config ? (
              <>
                {config.actuationMm.toFixed(2)}
                <span className="dim small"> ({mmToCounts(config.actuationMm)})</span>
              </>
            ) : (
              '—'
            )}
          </dd>

          <dt>{t('perf.col.rt')}</dt>
          <dd className={rt?.enabled ? undefined : 'dim'}>{config ? rtLabel(config) : '—'}</dd>

          {/*
            Both sensitivities, whether or not rapid trigger is on.
            
            They are stored per key either way, and reading them back is how you
            find out what turning it on would do — a dash there answers "is it
            on", which the row above already answered. Dimmed while it is off,
            because a value the board is not acting on should not read like one
            it is.
          */}
          <dt>{t('keyInfo.rtPress')}</dt>
          <dd className={rt?.enabled ? 'mono' : 'mono dim'}>
            {rt ? `${rt.pressMm.toFixed(2)} mm` : '—'}
          </dd>

          <dt>{t('keyInfo.rtRelease')}</dt>
          <dd className={rt?.enabled ? 'mono' : 'mono dim'}>
            {rt ? `${rt.releaseMm.toFixed(2)} mm` : '—'}
          </dd>

          <dt>{t('perf.col.deadzone')}</dt>
          <dd className={config?.deadZone.enabled ? 'mono' : 'dim'}>
            {config ? deadZoneLabel(config) : '—'}
          </dd>

          <dt>{t('perf.col.switch')}</dt>
          <dd>
            {config ? (
              <>
                {/* The board definition's colour for this type — a label, not
                    something the board reported. See ui/SwitchSwatch.tsx. */}
                <SwitchSwatch value={config.switchType} />
                {switchTypeName(config.switchType)}
                <span className="dim small"> · {travelOf(config).toFixed(2)} mm</span>
              </>
            ) : (
              '—'
            )}
          </dd>

          {/*
            Where the key lives in the three tables that address it, which are
            three different numbers and are only ever confused for each other by
            someone reading the protocol. Nothing on a keyboard is answered by
            them, so they are behind debug mode with the rest of the byte-level
            facts — see tools/KeyPerfBlock.tsx.
          */}
          {debug && (
            <>
              <dt>{t('keyInfo.addresses')}</dt>
              <dd className="mono dim">
                {t('keyInfo.addressList', {
                  index: key.index,
                  keyIndex: key.keyIndex,
                  lightIndex: key.lightIndex,
                  usage: `0x${key.code.toString(16).padStart(2, '0')}`,
                })}
              </dd>
            </>
          )}
        </dl>
      </div>
    </Panel>
  )
}

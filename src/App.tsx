import {
  IconActivity,
  IconArrowBarToDown,
  IconBug,
  IconBulb,
  IconKeyboard,
  IconLayoutDashboard,
  IconPlayerRecord,
  IconSettings as IconSettingsGlyph,
  IconStack2,
  IconUsb,
  type Icon,
} from '@tabler/icons-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Advanced } from './features/Advanced'
import { Connect } from './features/Connect'
import { InputPoint } from './features/InputPoint'
import { Keymap } from './features/Keymap'
import { Lighting } from './features/Lighting'
import { Macro } from './features/Macro'
import { Overview } from './features/Overview'
import { Settings } from './features/Settings'
import { useT, type MessageKey } from './i18n'
import { LanguageSelect } from './i18n/LanguageSelect'
import { Debug } from './tools/Debug'
import { DevicePanel } from './tools/DevicePanel'
import { Sensors } from './tools/Sensors'
import { useCalibrationMode } from './state/calibration'
import { DebugGesture } from './ui/DebugGesture'
import { DeviceCard } from './ui/DeviceCard'
import { selection } from './state/selection'
import { link, useCodec, useCodecAutoSelect, useConnection } from './state/link'
import { useSettings } from './state/settings'

interface Tab {
  id: string
  labelKey: MessageKey
  /**
   * The glyph beside the label, from Tabler (https://tabler.io/icons).
   *
   * To change one: find the icon on that page, and the component is `Icon` plus
   * its name in PascalCase — "layout-dashboard" is `IconLayoutDashboard`. Add
   * it to the import at the top of this file and put it here. The set is
   * tree-shaken, so only the ones named in this file reach the bundle.
   *
   * They are decorative and marked `aria-hidden`: each one sits next to the
   * label it illustrates, and a screen reader announcing both would say
   * everything twice.
   */
  icon: Icon
  render: () => ReactNode
}

/**
 * What the board is configured to do, in the order someone works through it:
 * what it is, then what its keys send, then how they trigger, then the rest.
 * These sit at the top of the sidebar.
 */
const TOP_TABS: Tab[] = [
  { id: 'overview', labelKey: 'app.tab.overview', icon: IconLayoutDashboard, render: () => <Overview /> },
  { id: 'keymap', labelKey: 'app.tab.keymap', icon: IconKeyboard, render: () => <Keymap /> },
  { id: 'input', labelKey: 'app.tab.input', icon: IconArrowBarToDown, render: () => <InputPoint /> },
  { id: 'advanced', labelKey: 'app.tab.advanced', icon: IconStack2, render: () => <Advanced /> },
  { id: 'light', labelKey: 'app.tab.light', icon: IconBulb, render: () => <Lighting /> },
  { id: 'macro', labelKey: 'app.tab.macro', icon: IconPlayerRecord, render: () => <Macro /> },
]

/**
 * Not things you configure: one checks that what you configured works, the
 * other is the app's own settings. They are pushed to the bottom of the
 * sidebar, away from the run of tabs you move through in order.
 */
const BOTTOM_TABS: Tab[] = [
  { id: 'sensors', labelKey: 'app.tab.sensors', icon: IconActivity, render: () => <Sensors /> },
  // Aliased on import: this file already has a Settings, and it is the tab.
  { id: 'settings', labelKey: 'app.tab.settings', icon: IconSettingsGlyph, render: () => <Settings /> },
]

/**
 * Shown only with debug mode on, which is reached by tapping Shift five times
 * — see state/debugGesture.ts. Below the bottom group, under a rule.
 *
 * The interface picker is one of them: connecting opens the highest-ranked
 * interface on its own (hid/filters.ts), so choosing between them by hand,
 * with their scores and the reasons behind them, is only useful while working
 * out what the board exposes.
 */
const DEBUG_TABS: Tab[] = [
  { id: 'debug', labelKey: 'app.tab.debug', icon: IconBug, render: () => <Debug /> },
  { id: 'interface', labelKey: 'app.tab.interface', icon: IconUsb, render: () => <DevicePanel /> },
]

export default function App() {
  useCodecAutoSelect()
  const [active, setActive] = useState(TOP_TABS[0]!.id)
  const { connected } = useConnection()
  const { debug } = useSettings()
  const codec = useCodec()
  const t = useT()
  // Calibration holds the board in a mode where it cannot type, and only the
  // button inside that mode ends it cleanly — so while it runs the chrome is
  // dimmed and cannot be clicked. Switching tabs would unmount the run, and
  // disconnecting would leave the board unable to type until it was unplugged,
  // because the release packet cannot go through a closed device.
  const calibrating = useCalibrationMode()
  const blocked = calibrating ? ' blocked' : ''
  const tabs = [...TOP_TABS, ...BOTTOM_TABS, ...(debug ? DEBUG_TABS : [])]
  // Turning debug mode off while one of its tabs is open falls back to the
  // first tab rather than rendering nothing.
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]!

  // A selection belongs to the tab it was made in. Carrying it to another tab
  // and back leaves invisible context that the next write would silently obey.
  useEffect(() => selection.clear(), [active])

  const renderTab = ({ icon: Glyph, ...tb }: Tab) => (
    <button
      key={tb.id}
      role="tab"
      aria-selected={tb.id === active}
      // The backdrop stops the mouse; `disabled` stops the keyboard, which
      // would otherwise tab straight through it.
      disabled={calibrating}
      onClick={() => setActive(tb.id)}
    >
      <Glyph aria-hidden />
      {t(tb.labelKey)}
    </button>
  )

  // Everything the chrome carries — which board, which codec, disconnect, the
  // tabs — is about an attached device, so with none attached there is nothing
  // left to put in it and the connect screen has the window to itself.
  if (!connected) {
    return (
      <div className="app">
        <Connect />
        <DebugGesture />
      </div>
    )
  }

  return (
    <div className="app">
      <header className={`topbar${blocked}`} aria-hidden={calibrating || undefined}>
        <h1>Raven61 Web Driver</h1>
        {/*
          No connection badge here any more: which board is attached is the
          rail's device card, and whether it holds what is on screen is the
          corner badge (ui/SyncBadge.tsx), next to the build it belongs beside.
        */}
        <span className="spacer" />
        <span className="small dim">{t('app.codec', { codec: t(codec.labelKey) })}</span>
        {/*
          The language picker lives here rather than in the settings tab: it is
          the one preference someone may need before they can read the tab that
          used to hold it. The connect screen carries its own copy, since the
          top bar only exists once a board is attached.
        */}
        <LanguageSelect />
        <button onClick={() => void link.close()}>{t('device.disconnect')}</button>
      </header>

      <div className="body">
        {/*
          The left column: which board, then where to go in it. Two cards
          rather than one, because they answer different questions and only one
          of them is something to click.
        */}
        <div className={`rail${blocked}`} aria-hidden={calibrating || undefined}>
          <DeviceCard />

          <nav className="sidebar" role="tablist" aria-orientation="vertical">
            <div className="group">{TOP_TABS.map(renderTab)}</div>

            {/* Held at the foot of the column by the gap above it, so the two
                kinds of tab do not read as one list of nine. */}
            <div className="group foot">
              {BOTTOM_TABS.map(renderTab)}
              {/* Below a rule rather than mixed in: these are not tabs of the
                  same kind, and someone who turned debug mode on should be
                  able to see where the app ends and the lab begins. */}
              {debug && <hr className="sep" />}
              {debug && DEBUG_TABS.map(renderTab)}
            </div>
          </nav>
        </div>

        <main className="content">{tab.render()}</main>
      </div>

      {/*
        Outside the blocked chrome: it is a toast, not a control, and the
        gesture behind it declines to fire during calibration anyway.
      */}
      <DebugGesture />
    </div>
  )
}

import {
  IconActivity,
  IconArrowBarToDown,
  IconBug,
  IconBrandGithub,
  IconBulb,
  IconKeyboard,
  IconLayoutDashboard,
  IconMenu2,
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
import { translate, useLocale, useT, type MessageKey } from './i18n'
import { LanguageSelect } from './i18n/LanguageSelect'
import { Debug } from './tools/Debug'
import { DevicePanel } from './tools/DevicePanel'
import { Sensors } from './tools/Sensors'
import { useCalibrationMode } from './state/calibration'
import { DebugGesture } from './ui/DebugGesture'
import { DeviceCard } from './ui/DeviceCard'
import { TabActionSlot } from './ui/TabActions'
import { TabPinnedSlot } from './ui/TabPinned'
import { useExit } from './ui/useExit'
import { VersionBadge } from './ui/VersionBadge'
import { selection } from './state/selection'
import { useCodecAutoSelect, useConnection } from './state/link'
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
/**
 * Where this app comes from, behind the mark in the top bar.
 *
 * Written out rather than read from the git remote: the remote is a property
 * of whoever's checkout is building, and a fork's build should still point a
 * reader at the project it is a fork of.
 */
const REPO_URL = 'https://github.com/SuFl3770/Raven61WebDriver'

const DEBUG_TABS: Tab[] = [
  { id: 'debug', labelKey: 'app.tab.debug', icon: IconBug, render: () => <Debug /> },
  { id: 'interface', labelKey: 'app.tab.interface', icon: IconUsb, render: () => <DevicePanel /> },
]

export default function App() {
  useCodecAutoSelect()
  const [active, setActive] = useState(TOP_TABS[0]!.id)
  /*
   * Whether the left column is showing, which only means anything on a narrow
   * window — see `.rail` in styles.css. Above the breakpoint the rail is part
   * of the layout and this flag is ignored, so nothing here has to ask how
   * wide the window is; the stylesheet is the only thing that knows.
   */
  const [railOpen, setRailOpen] = useState(false)
  /*
   * The element a tab's controls are rendered into — see ui/TabActions.tsx.
   * State rather than a ref because the tabs below have to re-render once it
   * exists, and a ref changing tells nobody.
   */
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null)
  /*
   * The other slot: the band between the title and the panels, which is where
   * a tab's key grid is drawn — see ui/TabPinned.tsx. State for the same
   * reason as the one above.
   */
  const [pinnedSlot, setPinnedSlot] = useState<HTMLElement | null>(null)
  const { connected } = useConnection()
  const { debug } = useSettings()
  const t = useT()
  const locale = useLocale()
  // Calibration holds the board in a mode where it cannot type, and only the
  // button inside that mode ends it cleanly — so while it runs the chrome is
  // dimmed and cannot be clicked. Switching tabs would unmount the run, and
  // disconnecting would leave the board unable to type until it was unplugged,
  // because the release packet cannot go through a closed device.
  const calibrating = useCalibrationMode()
  /*
   * The veil behind the drawer, held in the tree for the length of its fade so
   * that it can leave rather than blink out. 200ms is the rule in styles.css
   * that draws the exit — see ui/useExit.ts for why the two are named in each
   * other's comments instead of one reading the other.
   */
  const scrim = useExit(railOpen, 200)
  const blocked = calibrating ? ' blocked' : ''
  const tabs = [...TOP_TABS, ...BOTTOM_TABS, ...(debug ? DEBUG_TABS : [])]
  // Turning debug mode off while one of its tabs is open falls back to the
  // first tab rather than rendering nothing.
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]!

  // A selection belongs to the tab it was made in. Carrying it to another tab
  // and back leaves invisible context that the next write would silently obey.
  useEffect(() => selection.clear(), [active])

  // Escape closes the drawer, the way it closes everything else that covers
  // what is behind it. Bound only while it is open, so nothing is listening
  // for a key it has no use for — which is every moment on a wide window.
  useEffect(() => {
    if (!railOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRailOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railOpen])

  const renderTab = ({ icon: Glyph, ...tb }: Tab) => (
    <button
      key={tb.id}
      role="tab"
      aria-selected={tb.id === active}
      // The backdrop stops the mouse; `disabled` stops the keyboard, which
      // would otherwise tab straight through it.
      disabled={calibrating}
      onClick={() => {
        setActive(tb.id)
        // Picking a tab is what the drawer was opened for, so it has done its
        // job. Unconditional: on a wide window the flag is not read by
        // anything, so there is nothing to guard against.
        setRailOpen(false)
      }}
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
        {/*
          The bar carries the wordmark and nothing else. What used to sit here
          — the app's name, and the codec in use — is said better elsewhere:
          which board is attached is the rail's device card, whether it holds
          what is on screen is the corner badge (ui/SyncBadge.tsx), and the
          codec is in the interface panel beside the rest of the link's state.

          Spacers either side rather than `justify-content: center`, so the
          wordmark is centred on the bar itself and stays put if anything is
          ever added to one end.
        */}
        {/*
          Shown only where it does something: the stylesheet drops it above the
          width at which the rail is simply part of the page. `aria-expanded`
          rather than a label that changes with the state — the name of a
          control should stay put, and the state has its own attribute.
        */}
        <button
          className="menu"
          aria-expanded={railOpen}
          aria-controls="rail"
          aria-label={t('app.menu')}
          title={t('app.menu')}
          disabled={calibrating}
          onClick={() => setRailOpen((open) => !open)}
        >
          <IconMenu2 aria-hidden />
        </button>

        {/*
          A mark, not a heading. The document's heading is the open tab's name,
          below the bar — a screen reader walking the headings should land on
          where it is, not on what the app is called, which the bar says the
          same way on every one of them.
        */}
        <div className="wordmark">HE</div>
        {/*
          Opened in a new tab, always. This one holds the device: WebHID grants
          it to the page, and navigating away closes it — someone who clicked
          through to the source and came back would find the board disconnected
          and every unapplied change gone.

          `pointer-events: none` on `.blocked` stops the mouse during
          calibration but not the keyboard, so the link is taken out of the tab
          order for the length of the run the same way the tabs are.
        */}
        <a
          className="repo"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          title={t('app.repo')}
          aria-label={t('app.repo')}
          tabIndex={calibrating ? -1 : undefined}
        >
          <IconBrandGithub aria-hidden />
        </a>
      </header>

      <div className="body">
        {/*
          The left column: which board, then where to go in it. Two cards
          rather than one, because they answer different questions and only one
          of them is something to click.
        */}
        {/*
          Only ever seen on a narrow window, where the rail is drawn over the
          page rather than beside it: something to click that is not the drawer
          and not the page behind it. The stylesheet hides it above the
          breakpoint, so it costs a div and nothing else on a wide one.
        */}
        {scrim.mounted && (
          <div
            className={`scrim${scrim.closing ? ' closing' : ''}`}
            onClick={() => setRailOpen(false)}
          />
        )}

        <div
          id="rail"
          className={`rail${railOpen ? ' open' : ''}${blocked}`}
          aria-hidden={calibrating || undefined}
        >
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

          {/*
            The foot of the rail: how to read the app, and which build it is.
            Neither belongs to a tab, and neither is worth the width of the top
            bar — the language picker was up there because the settings tab was
            once the only place to find it, and the build badge was pinned to
            the corner of the window, floating over whatever scrolled beneath.
          */}
          <div className="rail-foot">
            <LanguageSelect />
            <VersionBadge />
          </div>
        </div>

        {/*
          Keyed by the tab, which is what replays the animations: a new key is
          a new subtree, and a CSS animation runs when an element appears.
          Without it React would keep these divs across the switch and only
          swap what is inside, and nothing would move.

          It reaches further than the two bands that slide — see `.tab-title`
          and `.tab-scroll` in styles.css. Every cap in the grid is rebuilt
          too, which is what fades in the numbers, bands and paint the new tab
          puts on a keyboard that is otherwise holding still.
        */}
        <main className="content">
          <div key={tab.id} className="tab-in">
            {/*
              Which tab is open, said in the content rather than only in the
              rail. On a narrow window the rail is a drawer that is shut most
              of the time, and without this there is nothing on screen naming
              the page — but it earns its place on a wide one too, as the
              heading the panels below it hang off. They are `h2`, so this is
              the `h1` the bar gave up.
            */}
            <header className="tab-title">
              <div className="tab-heading">
                <h1>{t(tab.labelKey)}</h1>
              {/*
                The same name in English, under the one the reader chose.
                Dropped when English *is* that choice, where it would only
                repeat the line above it, and hidden from screen readers in
                every case — it is the heading a second time, and a reader that
                announced both would say the page's name twice before
                reaching it.

                `translate` rather than `t`: this line is pinned to one
                language on purpose, so it cannot follow the picker.
              */}
                {locale !== 'en' && <p aria-hidden>{translate('en', tab.labelKey)}</p>}
              </div>

              {/*
                Empty here, and filled by whatever the tab renders — the key
                grid's controls are the only ones so far. Kept in the markup
                rather than mounted on demand so the row's shape does not
                depend on what is about to be put in it.
              */}
              <div className="tab-actions" ref={setActionSlot} />
            </header>

            {/*
              Between the title and the panels, and outside the box that
              scrolls: the key grid, on the three tabs that draw one. Empty on
              the rest, where the stylesheet drops it — see `.tab-pin`.
            */}
            <div className="tab-pin" ref={setPinnedSlot} />

            {/*
              The only part of a tab that scrolls. The title above it, the grid
              beside it in the band, and the sub-tab strip inside it — which
              sticks to the top of this box rather than being lifted out of it
              — all stay where they are while the panels move under them.
            */}
            <div className="tab-scroll">
              <TabActionSlot value={actionSlot}>
                <TabPinnedSlot value={pinnedSlot}>{tab.render()}</TabPinnedSlot>
              </TabActionSlot>
            </div>
          </div>
        </main>
      </div>

      {/*
        Outside the blocked chrome: it is a toast, not a control, and the
        gesture behind it declines to fire during calibration anyway.
      */}
      <DebugGesture />
    </div>
  )
}

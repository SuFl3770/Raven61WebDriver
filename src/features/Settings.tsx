import { useT } from '../i18n'
import { AccentPicker } from '../ui/AccentPicker'
import { BackgroundPicker } from '../ui/BackgroundPicker'
import { BoardSettings } from '../ui/BoardSettings'
import { FactoryReset } from '../ui/FactoryReset'
import { DeviceInfo } from '../ui/DeviceInfo'
import { Panel, PanelGroup } from '../ui/Panel'
import { ProfileStorage } from '../ui/ProfileStorage'
import { ThemePicker } from '../ui/ThemePicker'

/**
 * What is on this tab, and what left it.
 *
 * Two panels, split by who keeps the setting. Everything in the board panel
 * reaches the keyboard and stays there when the browser is closed; everything
 * in the driver panel lives in this browser and the keyboard never hears about
 * it. That is the only line worth drawing here — it is what tells you whether
 * a thing follows the board to another machine — so it is the one the headings
 * draw, and the eight separate panels this used to be are groups under them.
 *
 * Inside each panel the groups sit in two columns rather than a stack. Every
 * one of them is a couple of rows tall, and stacked they left a column of empty
 * page down the right of a tab that has nothing else to put there. Reading
 * order is unchanged — left column first, then right: the board panel keeps the
 * two settings the board holds on the left and the profile file on the right,
 * and the driver panel keeps the theme and accent on the left, because the theme
 * decides which surfaces the accent has to work against, with the wallpaper on
 * the right because it is drawn under both.
 *
 * The factory reset stays out of the columns, across the foot of the board
 * panel. It is the one control here that can lose something, and a destructive
 * button beside an ordinary one reads as another ordinary one.
 *
 * The device panel stays outside both. It is not a setting — nothing on it
 * can be changed — and it is what identifies the board the panel below is
 * talking to, so it reads as a header for the tab rather than an item in it.
 *
 * Three things that used to be here are not any more. The language picker moved
 * to the top bar, where it is reachable from every tab rather than only from
 * this one. The built-in-identity-table switch moved to the debug tab, which is
 * where it belongs: it exists for working out how the board names its keys, and
 * it means nothing to someone who just wants a different actuation point. And
 * the debug-mode checkbox is not a control at all any more — five quick taps of
 * Shift toggle it (see state/debugGesture.ts), which suits something nobody
 * configuring a keyboard has a reason to find.
 */
export function Settings() {
  const t = useT()

  return (
    <>
      <DeviceInfo />

      <Panel title={t('board.title')}>
        <div className="settings-cols">
          <div>
            {/*
              Untitled: the panel heading above already names these two. The
              hidden line is what keeps the first select level with the first
              button of the titled group beside it — see `.ghost-title`.
            */}
            <BoardSettings />
          </div>
          <ProfileStorage />
          <FactoryReset />
        </div>
      </Panel>

      <Panel title={t('settings.driver.title')}>
        <div className="settings-cols">
          <div>
              <ThemePicker />
          </div>
          <AccentPicker />
          <BackgroundPicker />
        </div>
      </Panel>
    </>
  )
}

import { useT } from '../i18n'
import { AccentPicker } from '../ui/AccentPicker'
import { BackgroundPicker } from '../ui/BackgroundPicker'
import { BoardSettings } from '../ui/BoardSettings'
import { FactoryReset } from '../ui/FactoryReset'
import { FirmwareInfo } from '../ui/FirmwareInfo'
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
 * Inside the board panel the order is the same as it was: the two settings the
 * board holds, the profile panel that saves all of it to a file and puts a file
 * back, and last the one control that throws them away. In the driver panel the
 * theme comes first because it decides which surfaces the accent has to work
 * against, and the wallpaper is last because it is drawn under both.
 *
 * The firmware panel stays outside both. It is not a setting — nothing on it
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
      <FirmwareInfo />

      <Panel title={t('board.title')}>
        {/* Untitled: the panel heading above already names these two. */}
        <BoardSettings />
        <hr className="panel-sep" />
        <ProfileStorage />
        <hr className="panel-sep" />
        {/*
          Last, and on purpose. Nothing else in this panel can lose anything,
          and a control that can should not sit next to the ones that cannot.
        */}
        <FactoryReset />
      </Panel>

      <Panel title={t('settings.driver.title')}>
        <PanelGroup>
          <ThemePicker />
          <AccentPicker />
        </PanelGroup>
        <hr className="panel-sep" />
        <BackgroundPicker />
      </Panel>
    </>
  )
}

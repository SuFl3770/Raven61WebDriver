import { useT } from '../i18n'
import { AccentPicker } from '../ui/AccentPicker'
import { T } from '../i18n/T'
import { BoardSettings } from '../ui/BoardSettings'
import { FactoryReset } from '../ui/FactoryReset'
import { FirmwareInfo } from '../ui/FirmwareInfo'
import { Notice, Panel } from '../ui/Panel'
import { ThemePicker } from '../ui/ThemePicker'

/**
 * What is on this tab, and what left it.
 *
 * What the board holds comes first — its firmware, its two board-wide settings,
 * and last of all the one control that throws them away. The storage panel
 * between them is there to draw the line: everything else this app remembers
 * lives in the browser and never reaches the keyboard.
 *
 * The theme and point-colour pickers sit below the storage panel rather than
 * above it, because they are two of the things that panel is talking about:
 * both are kept in this browser and neither reaches the keyboard. Theme first —
 * it decides which surfaces the accent has to work against.
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
      <BoardSettings />

      <Panel title={t('settings.storage.title')}>
        <Notice>
          <span className="small">
            <T k="settings.storage.hint" />
          </span>
        </Notice>
      </Panel>

      <ThemePicker />
      <AccentPicker />

      {/*
        Last, and on purpose. Nothing else on this tab can lose anything, and a
        control that can should not sit next to the ones that cannot.
      */}
      <FactoryReset />
    </>
  )
}

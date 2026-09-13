import { useT } from '../i18n'
import { kindKey, type AdvancedKind } from '../protocol/advancedKeys'

/**
 * An advanced key named inside a line of text, as a filled chip.
 *
 * For the readouts under a grid. The caps carry the same six fills as a band
 * along their bottom edge — `KeyGrid` draws those itself — and this is the
 * same fill in the shape a sentence can hold, so "which key is this line about"
 * is answered by colour before the words are read.
 *
 * The word stays inside the fill rather than beside it. The colour is what
 * carries at a glance; the word is what stops the colour being a code that has
 * to be learnt somewhere else. See `.advkind` in styles.css.
 */
export function KindChip({ kind }: { kind: AdvancedKind }) {
  const t = useT()
  /*
   * `advkind-dks`, not `dks`. The kind names are three-letter words this
   * stylesheet already uses for other things — `.dks` is the DKS editor's own
   * panel — and a chip that quietly picked up a margin from one of them is a
   * bug that only shows as a few pixels in the wrong place.
   */
  return <span className={`advkind advkind-${kind}`}>{t(kindKey(kind))}</span>
}

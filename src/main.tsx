import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadUserSpecsAndReport } from './device/userSpecs'
import { startAccent } from './state/accent'
import { startBackground } from './state/background'
import { startTheme } from './state/theme'
import { ApplyToast } from './ui/ApplyToast'
import { SyncBadge } from './ui/SyncBadge'
import { TooSmall } from './ui/TooSmall'
// Before the stylesheet that uses it. Nothing in the cascade depends on the
// order — @font-face is a declaration, not a rule — but the family the app is
// set in should be the first thing the file that sets it can be read against.
import './assets/fonts/noto-sans-kr.css'
import './styles.css'

// Before the first render, so the app is painted once in the theme and colour
// it keeps rather than flashing the stylesheet's defaults first.
startTheme()
startAccent()
// The two amounts land with these; the picture itself comes from IndexedDB a
// frame or two later, which is as early as an asynchronous store allows.
startBackground()

// Board definitions a user dropped into src/device/user/. Before the first
// render too: the registry decides which layout the key grid draws, and a spec
// registered after that would leave the first paint showing the wrong board.
// The only place this is imported, so the protocol layer stays free of Vite's
// glob and the hardware checks can bundle it under node.
loadUserSpecsAndReport()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />

    {/*
      The corner: whether the board holds what is on screen. Outside <App /> so
      it stays put while the content scrolls and the layout does not have to
      make room for it. The build badge that used to sit under it has moved to
      the foot of the rail, which is where the rest of the app's own chrome is.
    */}
    <div className="corner">
      <SyncBadge />
    </div>

    <ApplyToast />
    {/*
      Outside <App />, which swaps its whole tree for the connect screen when no
      board is attached: a window too small to lay the app out is too small for
      that screen too, and the warning must not lose its "carry on" when the
      board is plugged in.
    */}
    <TooSmall />
  </StrictMode>,
)

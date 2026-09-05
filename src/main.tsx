import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startAccent } from './state/accent'
import { ApplyToast } from './ui/ApplyToast'
import { SyncBadge } from './ui/SyncBadge'
import { TooSmall } from './ui/TooSmall'
import { VersionBadge } from './ui/VersionBadge'
import './styles.css'

// Before the first render, so the app is painted once in the colour it keeps
// rather than flashing the stylesheet's default first.
startAccent()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />

    {/*
      The corner, stacked: what the board is doing, over what this build is.
      Outside <App /> so it stays put while the content scrolls and the layout
      does not have to make room for it.
    */}
    <div className="corner">
      <SyncBadge />
      <VersionBadge />
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

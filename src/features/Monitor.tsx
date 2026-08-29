import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_TRAVEL_MM, KEY_COUNT, keyByIndex } from '../keyboard/raven61'
import { sensorMap } from '../state/sensorMap'
import { supports } from '../protocol/codec'
import type { KeySample } from '../protocol/types'
import { link, useCodec, useConnection } from '../state/link'
import { selection, useSelection } from '../state/selection'
import { KeyGrid } from '../ui/KeyGrid'
import { NotDecoded, Notice, Panel } from '../ui/Panel'

interface Stat {
  min: number
  max: number
  last: number
  samples: number
}

const HISTORY = 300

export function Monitor() {
  const codec = useCodec()
  const { connected } = useConnection()
  const sel = useSelection()
  const canMonitor = supports(codec, 'startMonitor')

  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, forceRender] = useState(0)

  // Sample data lives in refs: the stream can run far faster than React renders.
  const depths = useRef<Float32Array>(new Float32Array(KEY_COUNT))
  const stats = useRef<Stat[]>(
    Array.from({ length: KEY_COUNT }, () => ({ min: Infinity, max: -Infinity, last: 0, samples: 0 })),
  )
  const history = useRef<number[]>([])
  const stopFn = useRef<(() => Promise<void>) | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  /** Usages the board reported that this layout has no key for. */
  const unmapped = useRef<Map<string, number>>(new Map())

  const focus = [...sel][0] ?? 0

  const ingest = useCallback((samples: KeySample[]) => {
    for (const s of samples) {
      // Most keys are identified by HID usage; modifiers and Fn have none, so
      // they fall back to the sensor address bound in the events tab.
      const index = sensorMap.resolve(s)
      if (index === undefined) {
        // Never drop these silently: an unresolved key looks exactly like a
        // dead one in the grid, and the difference matters.
        unmapped.current.set(s.fingerprint, (unmapped.current.get(s.fingerprint) ?? 0) + 1)
        continue
      }
      const key = { index }
      depths.current[key.index] = s.depthMm
      const st = stats.current[key.index]!
      st.min = Math.min(st.min, s.depthMm)
      st.max = Math.max(st.max, s.depthMm)
      st.last = s.depthMm
      st.samples++
    }
  }, [])

  const start = async () => {
    setError(null)
    try {
      stopFn.current = await codec.startMonitor!(link, ingest)
      setRunning(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const stop = async () => {
    try {
      await stopFn.current?.()
    } finally {
      stopFn.current = null
      setRunning(false)
    }
  }

  const reset = () => {
    stats.current = Array.from({ length: KEY_COUNT }, () => ({
      min: Infinity,
      max: -Infinity,
      last: 0,
      samples: 0,
    }))
    history.current = []
    unmapped.current = new Map()
  }

  // Redraw at display rate rather than sample rate.
  useEffect(() => {
    if (!running) return
    let raf = 0
    const tick = () => {
      history.current.push(depths.current[focus] ?? 0)
      if (history.current.length > HISTORY) history.current.shift()
      drawTrace(canvas.current, history.current)
      forceRender((n) => n + 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, focus])

  useEffect(() => () => void stopFn.current?.(), [])

  if (!canMonitor) {
    return (
      <Panel title="실시간 키 깊이 모니터">
        <NotDecoded what="아날로그 스트리밍" />
        <div className="small dim" style={{ marginTop: 8 }}>
          이 코덱은 아날로그 스트리밍을 구현하지 않습니다. <b>이벤트</b> 탭에서 보드가 리포트를 올려보내는지
          먼저 확인하세요.
        </div>
      </Panel>
    )
  }

  const focusKey = keyByIndex(focus)
  const focusStat = stats.current[focus]!
  const noise = focusStat.samples > 0 && focusStat.max > focusStat.min ? focusStat.max - focusStat.min : 0

  return (
    <>
      <Panel title="실시간 키 깊이 모니터">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="primary" onClick={running ? stop : start} disabled={!connected}>
            {running ? '정지' : '시작'}
          </button>
          <button onClick={reset}>통계 초기화</button>
          <span className="small dim">
            포커스: #{focus} {focusKey?.label ?? ''} — 키를 클릭해 바꿉니다
          </span>
          <span className="small dim">
            보고된 키 {stats.current.filter((s) => s.samples > 0).length}/{KEY_COUNT}
          </span>
        </div>
        {error && <Notice kind="err">{error}</Notice>}
        {unmapped.current.size > 0 && (
          <div style={{ marginBottom: 10 }}>
            <Notice kind="warn">
              <span className="small">
                아직 키에 연결되지 않은 센서 주소:{' '}
                <span className="mono">
                  {[...unmapped.current.entries()].map(([fp, n]) => `${fp} (${n}회)`).join(', ')}
                </span>
                <div style={{ marginTop: 4 }}>
                  <b>이벤트</b> 탭의 센서 주소 패널에서 연결하세요.
                </div>
              </span>
            </Notice>
          </div>
        )}
        <KeyGrid
          selected={sel}
          onSelect={(i, additive) => selection.toggle(i, additive)}
          fill={(k) => (depths.current[k.index] ?? 0) / DEFAULT_TRAVEL_MM}
          sub={(k) => (depths.current[k.index] ?? 0).toFixed(2)}
        />
      </Panel>

      <Panel title={`트레이스 — #${focus} ${focusKey?.label ?? ''}`}>
        <canvas ref={canvas} width={880} height={160} style={{ width: '100%', maxWidth: 880 }} />
        <div className="row small dim" style={{ marginTop: 8 }}>
          <span>현재 {focusStat.last.toFixed(3)} mm</span>
          <span>최소 {Number.isFinite(focusStat.min) ? focusStat.min.toFixed(3) : '—'}</span>
          <span>최대 {Number.isFinite(focusStat.max) ? focusStat.max.toFixed(3) : '—'}</span>
          <span>
            정지 시 흔들림 {noise.toFixed(3)} mm — 래피드 트리거 민감도는 이 값보다 커야 합니다
          </span>
        </div>
      </Panel>
    </>
  )
}

function drawTrace(el: HTMLCanvasElement | null, data: readonly number[]): void {
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  const { width: w, height: h } = el
  ctx.clearRect(0, 0, w, h)
  ctx.strokeStyle = '#2a3441'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = (h / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  if (data.length < 2) return
  ctx.strokeStyle = '#4c9aff'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  data.forEach((mm, i) => {
    const x = (i / (HISTORY - 1)) * w
    const y = (Math.min(mm, DEFAULT_TRAVEL_MM) / DEFAULT_TRAVEL_MM) * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()
}

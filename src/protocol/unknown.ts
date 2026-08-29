import type { Raven61Codec } from './codec'

/**
 * Placeholder used until the Raven61 protocol is decoded. It implements no
 * capability, which makes every feature panel render its "protocol not yet
 * decoded" state instead of pretending to work.
 */
export const unknownCodec: Raven61Codec = {
  id: 'unknown',
  label: '미해독 (raw 모드)',
  confidence: 'none',
  notes:
    '프로토콜이 아직 해독되지 않았습니다. 탐색기·콘솔·프로버·트래픽 로그는 그대로 쓸 수 있습니다.',
  async probe() {
    return true
  },
}

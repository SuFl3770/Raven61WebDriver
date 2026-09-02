# Raven61 프로토콜 명세 (작성 중)

확인된 사실만 적습니다. 추측은 **추측** 이라고 명시합니다.
출처 표기: `[bin]` 순정 드라이버 바이너리, `[xml]` 순정 드라이버 데이터 파일,
`[hw]` 실제 장치에서 확인, `[cap]` USB 캡처, `[db]` 순정 드라이버 SQLite DB.

절차는 [reverse-engineering.md](./reverse-engineering.md), 각 사실을 어떻게 알아냈고
무엇이 틀렸었는지는 [findings.md](./findings.md) 참고.

---

## 1. 전송 계층 [bin] — 확정

| 항목 | 값 |
|------|-----|
| Vendor ID | `0x19F5` |
| Product ID | `0xFE20`, `0xFED0`, `0xFEB1` 중 하나 |
| USB 인터페이스 | `MI_01` (컴포지트 인터페이스 1) |
| 장치 열기 | `CreateFileA(path, GENERIC_READ\|WRITE, SHARE_READ\|WRITE, OPEN_EXISTING, FILE_FLAG_OVERLAPPED)` |
| 쓰기 | `WriteFile` = **OUTPUT 리포트** |
| 읽기 | 비동기 `ReadFile` = **INPUT 리포트** |
| 버퍼 크기 | **65 바이트** (리포트 ID 1 + 페이로드 64) |
| HID 리포트 ID | 0 |

> **정정.** 이전 판에서 FEATURE 리포트라고 적었던 것은 틀렸습니다. 바이너리에
> `HidD_SetFeature` / `HidD_GetFeature` 문자열이 있어 그렇게 추정했지만, 정적 분석 결과
> 두 함수는 `GetProcAddress` 로 **주소만 받아 두고 한 번도 호출되지 않습니다**
> (전역 `0x5a1f98` / `0x5a1f94` 에 대한 참조가 저장 1회뿐). `CH375*` 8개 임포트도
> 호출 0건인 죽은 코드입니다.
>
> 실제 통신은 `WriteFile` / `ReadFile` 이며, 이는 WebHID 의 `sendReport` 와
> `inputreport` 이벤트에 그대로 대응합니다. 즉 **웹 드라이버가 순정 드라이버와 똑같은
> 일을 할 수 있습니다.**

HID API 는 장치 열거·식별에만 쓰입니다: `SetupDiGetClassDevsA` 로 HID 장치를 훑고
`HidD_GetAttributes` 로 VID/PID 를, `HidP_GetCaps` 로 리포트 길이를 읽습니다
(`0x45cfd1`: caps+4 → InputReportByteLength, caps+6 → OutputReportByteLength).

읽기 래퍼는 `ReadFile` 이 돌려준 버퍼의 **선두 리포트 ID 가 0이면 그 1바이트를 벗겨서**
호출자에게 넘깁니다 (`0x45d1e3`). 그래서 응답의 첫 바이트는 페이로드 첫 바이트입니다.

## 2. 패킷 프레임 [bin] — 확정

`WriteFile` 에 넘어가는 65바이트 버퍼:

```
[0]      HID 리포트 ID (0)
[1]      매직 0x55            (펌웨어 업데이트는 0x5F)
[2]      명령
[3]      미사용 (관찰된 모든 호출에서 0)
[4]      체크섬 = sum(buffer[5..64]) & 0xFF
[5..64]  데이터 60바이트
```

리포트 ID 를 뺀 페이로드(WebHID 가 다루는 단위) 기준:

```
payload[0]      매직 0x55
payload[1]      명령
payload[2]      미사용
payload[3]      체크섬 (payload[4..63] 의 8비트 합)
payload[4..63]  데이터
```

체크섬 근거: `0x45a9a5`–`0x45a9dc` 의 루프가 10회 × 6바이트 = 60바이트를
`esi+5` 부터 `esi+64` 까지 더한 뒤 `mov byte ptr [esi+4], bl` 로 저장합니다.

### 2.1 블록 전송 [bin] — 확정

대부분의 명령은 독립된 동작이 아니라 **펌웨어 블롭의 바이트 범위를 한 패킷당 56바이트씩
옮기는 것**입니다. `0x0b` 명령 생성기(`0x429130`)에서 확인했습니다.

```
payload[4]      이 청크의 길이 (0x38 = 56, 마지막 청크는 더 짧음)
payload[5..6]   블롭 내 오프셋, 리틀엔디언 16비트
payload[7]      미사용
payload[8..63]  청크 데이터
```

근거가 되는 코드:

```
mov word ptr [ebp-0x53], 0xb55   ; buffer[1..2] = 55 0b  (매직 + 명령)
mov cl, 0x38                      ; 청크 길이 56
cmp ebx, 6 / cmove eax, 0x30      ; 마지막(7번째) 청크만 48
al = ((ebx*8 - ebx) << 3)         ; = ebx * 56  → 오프셋 하위 바이트
mov byte [ebp-0x4e], al           ; buffer[6] = payload[5]
... >> 8 → buffer[7] = payload[6] ; 오프셋 상위 바이트
movups [ebp-0x4b] ...             ; buffer[9..64] = 56바이트 데이터
```

`0x0b` 전송은 56×6 + 48 = **384바이트**입니다. 여러 명령 생성기가 **128**까지 도는
루프를 갖고 있어 384 = 128 슬롯 × 3바이트로 깔끔하게 나뉩니다. 키 인덱스가 109까지
올라가므로 128 슬롯이면 전체 키 주소 공간을 덮습니다.

명령별 스테이징 버퍼 크기(정적 분석):

| 명령 함수 | 블롭 크기 | 루프 |
|-----------|-----------|------|
| `0x428f00` (0x0b) | 0x190 = 400 | 384바이트 전송 |
| `0x42a3e0` (0xdd) | 0x190 = 400 | |
| `0x428a30` | 0x190 = 400 | 128 |
| `0x426050`, `0x427590` | 0x300 = 768 | 128 |
| `0x427120` | 0x448 = 1096 | 128 |
| `0x427ac0`, `0x427f80` | 0x362 = 866 | |
| `0x428440` (0x0d) | 0xe00 = 3584 | |
| `0x42a740`, `0x42b560` (a3/a5/a7) | 0x200, 0x1000 | 조명 |
| `0x42c390` (0xa1) | 0x400 = 1024 | |

`src/protocol/frame.ts` 의 `buildBlock()` 이 이 형식을 만듭니다.

### 전송 절차 [bin]

송수신 헬퍼 `0x45a940` 이 모든 명령에 공통입니다:

1. 체크섬 계산 후 `buffer[4]` 에 기록
2. `Sleep(2)`
3. `WriteFile` 65바이트 — 실패하면 1회 재시도
4. `Sleep(2)`, 수신 버퍼 65바이트 0으로 초기화
5. `ReadFile` 65바이트, **타임아웃 30 ms**
6. **응답 `payload[0] == 0xAA` 이면 성공** (`cmp cl, 0xAA` at `0x45aa8b`)

`src/protocol/frame.ts` 에 구현되어 있습니다.

## 3. 명령 표 [bin] [hw]

명령 바이트는 송수신 헬퍼의 호출 지점 52곳에서 추출했고
(`python tools/bin/commands.py "<순정 드라이버>/Raven Driver.exe"`),
응답은 실제 보드에 빈 페이로드로 보내 확인했습니다.

| 명령 | 응답 | ms | 확인 상태 |
|------|------|-----|-----------|
| `0x01` | `aa 01` | 3 | **확정** — 트랜잭션 시작. 모든 명령 함수가 이걸로 시작 |
| `0x02` | `aa 02` | 2 | **확정** — 트랜잭션 종료·적용 |
| `0x06` | `aa 06` | 3 | **확정** — 전역 설정 쓰기 (`0x429560` 이 `reporte_rate`, `tick_rate`, `dead_zone`, `disable_win`, `disable_alttab`, `disable_altf4`, `perf_tachyon_mode`, `perf_bottomrapidtrigger_mode` 참조) |
| `0x09` | `aa 09` | 5 | 미확인 (`0x427ac0`, `0x427f80`) |
| `0x0b` | `aa 0b` | 3 | 미확인 (`0x428f00` — 7회 반복, 레코드 56바이트) |
| `0x0d` | `aa 0d` | 3 | 미확인 (`0x428440`, `0x429a60`) |
| `0xa1` | `aa a1` | 3 | 미확인 (`0x42c390`) |
| `0xa3` | `aa a3` | 2 | 미확인 |
| `0xa5` | `aa a5` | **24** | ⚠ 보드 상태 변경 확인 |
| `0xa7` | `aa a7` | **21** | ⚠ 보드 상태 변경 확인 |
| `0xa8` | `aa a8` | 3 | `0xa9` 의 짝. 정지/해제로 추정 |
| `0xa9` | **데이터** | 1 | **데이터를 돌려주는 유일한 명령** — §3.2 |
| `0xdd` | `aa dd` | **54** | ⚠ 보드 상태 변경 확인 (`0x42a3e0`) |
| `0x5f` `0x06` | — | — | 펌웨어 업데이트 (`0x41ea70`, 매직이 다름) |

### 3.1 응답 형식 [hw] — 확정

**명령 응답은 요청의 에코입니다.** `payload[0]` 만 `0xAA` 로 바뀌고 나머지는 그대로
돌아옵니다.

```
보냄:  55 a9 00 38 38 00 00 …
받음:  aa a9 00 38 38 00 00 …
```

그래서 지금까지 관찰한 "ACK" 는 전부 에코였고, **명령이 실제로 무엇을 했는지 알려주지
않습니다**. 초기 스윕에서 전부 ACK 가 돌아온 것도 이 때문입니다.

응답에는 명령 바이트가 `payload[1]` 에 실려 오므로, 요청과 응답을 짝짓는 조건은
`payload[0] == 0xAA && payload[1] == 보낸 명령` 입니다
(`src/protocol/frame.ts` 의 `isReplyTo()`).

### 3.2 `0xa0` 아날로그 키 이벤트 [bin] [hw] — 해독 완료

`0xa0` 로 시작하는 리포트는 **보드가 요청 없이 올려보내는 아날로그 키 이벤트**입니다.
순정 드라이버는 `0x42c8a0` 에 전용 폴링 루프를 갖고 있습니다 — **쓰기 없이**
`readReport(버퍼, 65, 타임아웃 10ms)` 만 하고 `payload[0] == 0xa0` 이면
`0x426050(payload[1], payload[2], payload[3])` 로 넘깁니다.

Esc / A / Space 를 각각 한 번씩 눌렀다 뗀 16개 샘플을 교차 검증해 필드를 확정했습니다.
**16비트 필드는 빅엔디언**입니다 (§2.1 의 블록 오프셋이 리틀엔디언인 것과 다릅니다).

| 오프셋 | 크기 | 의미 |
|--------|------|------|
| `[0]` | 1 | `0xa0` 이벤트 마커 |
| `[1]` | 1 | `0x10` = 16, 본문 길이 |
| `[3]` | 1 | **키 HID usage** (Esc `0x29`, A `0x04`, Space `0x2c`) — DB 와 같은 주소 체계 |
| `[4..5]` | 2 BE | 스케일된 센서 델타. `(기준값 − 현재값) × 키별 게인` |
| `[7]` | 1 | **깊이, 0.02 mm 카운트** (0 = 안 눌림, 200 = 바닥) |
| `[8]` | 1 | 미상. 얕게 누를 땐 `[7]` 과 같고 바닥 근처에서 갈라짐 |
| `[9]` | 1 | **방향**: `0x01` 누르는 중, `0xff` 떼는 중 |
| `[12..13]` | 2 | 키별 센서값. 고정이지만 **고유하지 않음** — P 와 `/` 가 같은 값을 공유 |
| `[14..15]` | 2 BE | **총 스트로크 = 200 카운트 = 4.00 mm** (항상 고정) |
| `[16..17]` | 2 BE | 현재 ADC 값. 누를수록 감소 |
| `[18..19]` | 2 BE | 키별 안 눌린 상태의 ADC 기준값 (Esc 1877, A 1964, Space 1902) |

핵심은 **`[7]` 이 설정에서 쓰는 것과 똑같은 0.02 mm 카운트 단위의 실제 깊이**라는
점입니다. `[7] × 0.02` 가 안 눌림에서 정확히 0.00 mm, 바닥에서 정확히 4.00 mm 를 줍니다.

`[4..5]` 는 ADC 델타에 비례하는 값이고 게인이 키마다 다릅니다 (Esc 1.151, A 1.371,
Space 1.135). 즉 `[4..5]` 는 자속에 선형이고 거리에는 비선형이며, `[7]` 이 그것을
선형화한 실제 이동량입니다. 홀 센서의 물리와 맞습니다.

**총 스트로크가 4.00 mm 로 확정**되었습니다. 이전에 3.5 mm 로 가정했던 값을 고쳤습니다.

이 채널은 **읽기 전용이며 아무것도 켤 필요가 없습니다** — 키를 누르면 그냥 올라옵니다.
`src/protocol/frame.ts` 의 `parseKeyEvent()` 가 디코딩하고, 코덱의 `startMonitor` 가
여기에 연결되어 **모니터 탭이 실제로 동작합니다**.

#### 수정자 키는 usage 대신 센서 주소로 식별한다 [hw] — 확정

61키 **전부** 아날로그 이벤트를 보냅니다. 다만 8개는 `payload[3]` 이 HID usage 가 아닙니다:

| 키 | `payload[3]` |
|----|--------------|
| LShift / RShift / LCtrl / RCtrl / Win / LAlt / RAlt | `0x00` |
| Fn | `0x01` |

HID 에서 수정자는 키코드 배열이 아니라 **첫 바이트의 비트마스크**로 보고되므로 키코드가
없고, 펌웨어는 그 자리에 `0x00` 을 넣습니다. Fn 은 레이어 키라 `0x01` 입니다. 수정자가
아닌 키(Menu `0x65`, Space `0x2c` 등)는 전부 정상적인 usage 를 보고합니다.

그래서 `payload[3]` 만으로는 7개 수정자를 서로 구별할 수 없습니다.

`payload[12..13]` 을 키별 센서 주소로 봤지만 **틀렸습니다** — P 와 `/` 가 같은 값을
씁니다. 주소가 아니라 캘리브레이션 곡선이나 게인 선택자로 보입니다 (추측).
`payload[18..19]` 기준 ADC 는 키마다 다르므로, 두 값을 **조합**해야 식별자가 됩니다.

웹 드라이버의 식별 순서:

1. `payload[3]` 이 `0x01` 초과면 HID usage 로 키를 찾는다 (53개 키)
2. 아니면 `센서값:기준ADC` 조합을 연결 표에서 찾는다 (수정자 7개 + Fn)

#### 확정된 식별표 [hw]

8개 전부 하드웨어에서 측정해 `src/keyboard/fingerprints.ts` 에 넣었습니다. 연결 작업
없이 바로 동작합니다.

| 키 | usage | 센서값 | 기준 ADC | 인덱스 |
|----|-------|--------|----------|--------|
| LShift | `0xe1` | `0x0805` | 1888 | 41 |
| RShift | `0xe5` | `0x0808` | 1927 | 52 |
| LCtrl | `0xe0` | `0x0805` | 1880 | 53 |
| LWin | `0xe3` | `0x0801` | 1827 | 54 |
| LAlt | `0xe2` | `0x0806` | 1881 | 55 |
| RAlt | `0xe6` | `0x0806` | 1898 | 57 |
| RCtrl | `0xe4` | `0x0809` | 1905 | 59 |
| Fn | `0xff` | `0x0801` | 1815 | 60 |

센서값이 겹치는 조합과 기준 ADC 간격:

| 센서값 | 공유하는 키 | 최소 간격 |
|--------|-------------|-----------|
| `0x0801` | Fn 1815, LWin 1827 | 12 |
| `0x0805` | LCtrl 1880, LShift 1888 | 8 |
| `0x0806` | Esc 1877, LAlt 1881, RAlt 1898 | 4 |
| `0x0808` | RShift 단독 | — |
| `0x0809` | RCtrl 단독 | — |

Esc 는 usage 로 해석되므로 `0x0806` 의 4 간격은 실제로 문제되지 않습니다. 식별표에서
가장 가까운 쌍은 LCtrl / LShift 의 **8** 이므로, 허용 오차를 **±3** 으로 두었습니다.
그보다 멀거나 두 후보가 정확히 등거리면 **엉뚱한 키를 고르지 않고 미해석으로 남깁니다**.

기준 ADC 는 저장된 캘리브레이션 상수입니다 (한 키의 모든 샘플에서 값이 동일했습니다).
보드에서 **재캘리브레이션을 하면 이 값이 바뀌어 식별표가 어긋날 수 있습니다.** 그때는
이벤트 탭에서 다시 연결하면 되고, 사용자 연결이 내장 표보다 우선합니다.

알려진 다른 센서값: Esc `0x0806`(기준 1877), A `0x0702`(1964), Space `0x0808`(1902).

> 초기에 `0xa9` 의 응답으로 봤던 `a0 10 00 08 …` 도 사실 이 이벤트였습니다.
> 웹 드라이버의 `request()` 가 내용과 무관하게 "다음 입력 리포트" 를 응답으로 삼았기
> 때문입니다. 지금은 `isReplyTo()` 로 응답과 이벤트를 구분합니다.

### 3.3 ⚠ 빈 페이로드도 쓰기다 [hw]

빈 페이로드 스윕 후 **LED 가 WASD 흰색으로 바뀌었습니다.** 처음에는 유독 느렸던
`0xa5`(24ms) / `0xa7`(21ms) / `0xdd`(54ms) 를 범인으로 봤지만 **틀렸습니다** —
그 셋을 제외한 두 번째 스윕에서도 똑같이 LED 가 바뀌었습니다.

§2.1 을 알고 나면 설명이 됩니다. 이 명령들은 **블록 쓰기**이고, 빈 페이로드는
"오프셋 0 에 0을 쓴다" 는 뜻입니다. 조명 블롭의 앞부분이 덮어써진 것으로 보입니다.
길이 필드가 0이어도 펌웨어가 그대로 쓰는 듯합니다.

따라서 안전한 명령은 부작용이 관찰되지 않은 세 개뿐입니다:

| 분류 | 명령 |
|------|------|
| 안전 (`SAFE_COMMANDS`) | `0x01`, `0x02`, `0xa9` |
| 블록 쓰기 — 빈 페이로드로 보내지 말 것 | 나머지 전부 |

프로버가 기본적으로 안전한 명령만 보냅니다. 복구는 순정 드라이버에서 조명 프로파일을
다시 적용하면 됩니다.

### 3.4 트랜잭션

순정 드라이버는 **모든** 명령을 `0x01` … `0x02` 사이에서 보냅니다. 위 표는 각 명령을
단독으로 보낸 결과이므로, 대부분이 맨 ACK 만 돌려준 것이 이 때문일 수 있습니다.
프로버와 콘솔 모두 "0x01 … 0x02 로 감싸기" 옵션을 제공합니다.

## 4. 성능 설정 필드 [bin] [db] — 값 인코딩 확정

순정 드라이버의 SQLite 스키마 `t_key_perf_data` 가 키별 설정 모델 그대로입니다.

```sql
t_key_perf_data(
  perf_id, profile, key_code, switch_type, key_mode,
  key_actuation, rt_press, rt_release,
  deadzone_state, press_deadzone, release_deadzone)
```

### 4.1 스케일: 1 카운트 = 0.02 mm [db] — 확정

Esc 액추에이션만 바꿔 저장한 두 DB를 비교한 결과입니다.

| 순정 드라이버 설정 | `key_actuation` |
|---|---|
| 1.0 mm | 50 |
| 2.0 mm | 100 |
| 1.5 mm (공장 기본값 `global_key_actuation`) | 75 |

원점을 지나는 직선 위의 세 점 → **카운트 = mm x 50**, 즉 최소 단위 **0.02 mm**.
`rt_press` / `rt_release` / 데드존도 같은 스케일입니다 (기본 5 = 0.10 mm, 하단 데드존
기본 10 = 0.20 mm). `src/protocol/encoding.ts` 에 반영되어 있습니다.

### 4.2 `key_code` 는 HID usage 다 [db] — 확정

DB의 `key_code` 는 §6 의 `key_index` 가 **아닙니다**. 레이아웃 XML의 `code` 속성, 즉
HID usage 입니다. Esc = 41 (`0x29`), `1` = 30 (`0x1e`), LCtrl = 224 (`0xe0`),
Fn = 255 (`0xff`). `t_key_macro_data`, `t_userlightrgb_data` 도 동일합니다.

다만 이건 **드라이버 내부 모델**입니다. 실제 HID 명령이 usage 를 쓰는지 `key_index` 를
쓰는지는 아직 확인되지 않았습니다 — 캡처에서 Esc(41 vs 16) / A(4 vs 49) 를 비교하면
한 번에 갈립니다.

### 4.3 필드별 정리

| 컬럼 | 의미 | 확인된 값 |
|------|------|-----------|
| `profile` | 프로파일 번호 | 1, 2, 3 [db] |
| `key_code` | HID usage | 61종 [db] |
| `switch_type` | 스위치 종류 | 3 (이 보드) [db] |
| `key_mode` | 0 = 일반, 1 = 래피드 트리거 | [db] |
| `key_actuation` | 액추에이션 깊이 | 0.02 mm 단위 [db] |
| `rt_press` | RT 누름 민감도 | 0.02 mm 단위, 기본 5 [db] |
| `rt_release` | RT 뗌 민감도 | 0.02 mm 단위, 기본 5 [db] |
| `deadzone_state` | 데드존 사용 | 0/1 [db] |
| `press_deadzone` | 위쪽 데드존 | 0.02 mm 단위 [db] |
| `release_deadzone` | 아래쪽 데드존 | 0.02 mm 단위 [db] |

### 4.4 전역 설정 `t_config_data` [db]

프로파일 0은 공장 기본값, 1–3은 각 프로파일입니다.

| 키 | 기본값 | 의미 |
|----|--------|------|
| `global_key_actuation` | 75 | 1.5 mm |
| `global_rt1_pos` / `global_rt2_pos` | 5 / 5 | 0.1 mm |
| `global_sensitivity_pos` | 5 | 0.1 mm |
| `dead_zone` / `dead_zone_topvalue` / `dead_zone_bottomvalue` | 0 / 0 / 10 | 하단 0.2 mm |
| `perf_rapidtrigger_mode` | 1 | RT 사용 |
| `perf_continuerapidtrigger_mode` | 0 | 연속 RT |
| `perf_bottomrapidtrigger_mode` | 0 | 바닥 도달 시 항상 트리거 |
| `perf_sensitivity_mode` | 1 | 누름/뗌 분리 여부로 추정 |
| `perf_tachyon_mode` | 0 | "Tachyon Mode" |
| `reporte_rate` | 1 / 4 | 폴링 레이트 (원문 오타) |
| `debounce_level`, `key_respondtime`, `tick_rate` | 0–2 | |
| `switch_type` | 3 | |
| `disable_win` / `disable_alttab` / `disable_altf4` | 0 | 게임 모드 잠금 |
| `sleep_light`, `sleep_time`, `enable_light`, `lightmode` | | 조명 |
| `keyboard_layout` | 1 | |
| `version` | 1.0.1 | 설정 스키마 버전 |

DB 파일 이름은 `<device>_datav6.db` 입니다. `tools/db/extract.py` 로 mm 단위 JSON 으로
뽑거나 두 DB 를 비교할 수 있습니다.

```bash
python tools/db/extract.py "Raven61 HE_datav6.db" > profile.json
python tools/db/extract.py a.db --diff b.db
```

## 5. 고급 키 [bin]

```sql
t_magnetic_key_data(macro_id, profile, name, key_value, fn_layer,
  macro_type, key1_value, key2_value, key1_name, key2_name, reserved)
t_key_item_data(keyitem_id, macro_id,
  trigger_state1, trigger_state2, trigger_state3, trigger_state4,
  key_value, key_name)
```

`macro_type` 이 종류를 구분하며, UI 문자열상 다음 6종입니다 [bin]:

| 약어 | 이름 | 설명 |
|------|------|------|
| DKS | Dynamic Keystroke | 4단계 깊이에 최대 4개 기능. `trigger_state1..4` |
| MT | Mod Tap | 짧게 누르면 탭, 길게 누르면 수정자 (기본 200ms) |
| TGL | Toggle | 누르면 트리거 위치로 잠금 |
| RS | Rappy Snappy | 두 키 중 더 깊이 눌린 쪽 활성화 |
| SOCD | Snappy Tappy | 입력 우선순위 정리 |
| OKS | — | 키를 **뗄 때** 바인딩 키가 발동 |

프로파일당 고급 키는 최대 40개 [bin].

## 6. 키 인덱스 ↔ 물리 위치 [xml] — 확인됨

순정 드라이버 `layouts/Raven61.xml` 의 `key_index` 가 펌웨어 키 주소입니다.
`src/keyboard/raven61.ts` 에 생성되어 들어가 있으며,
`tools/layout/from-vendor-xml.mjs` 로 재생성합니다.

시각 순서와 다르므로 주의:

| 키 | key_index | 키 | key_index |
|----|-----------|----|-----------|
| Esc | 16 | Backspace | **92** |
| Tab | 32 | `\` | **60** |
| Caps | 48 | Enter | **76** |
| LShift | 64 | RShift | 75 |
| LCtrl | 80 | Menu | **109** |
| Space | 83 | Fn | 85 |

숫자열 16–28, Q행 32–44, A행 48–59, Z행 64–74, 하단 80–87 로 16 단위 행 경계를
가집니다 (`col_count=16`). 넓은 키(Backspace·Enter·`\`·Menu)만 다른 행에 배선되어 있습니다.

하단 행 순서는 **Ctrl, Win, Alt, Space, Alt, Menu, Ctrl, Fn** 입니다 — Fn이 맨 오른쪽.

LED 주소 `light_index` 는 대개 `key_index` 와 같습니다. 다만 `-` 키가 `T` 와 같은 37로
적혀 있어 순정 XML의 오기로 보입니다.

## 7. 레이어와 프로파일 [db] — 확정

- **프로파일 3개** (`t_profile_data`: Profile 1/2/3). `t_config_data` 의 프로파일 0은
  공장 기본값 행입니다.
- **레이어 4개** (`t_key_macro_data.fn_layer` 0–3). 순정 드라이버 UI 문구에는 FN Layer
  1–8 이 있지만 이 보드 데이터에는 0–3만 존재하며, 2·3은 전부 미할당입니다.
  UI 문구는 여러 모델이 공유하는 텍스트로 보입니다.
- `fn_layer` **101** 이 프로파일 1에만 추가로 존재합니다. 0번과 1번을 합친 형태이고,
  Fn 키 자신이 `macro_type=12, macro_value=511 (desc "FN1")` 즉 **레이어 전환 액션**으로
  들어가 있습니다. 0/1번에서는 Fn 키가 HID usage 228(RCtrl)로 저장됩니다.
  역할 미확정 — 보드에 실제로 내려가는 통합 키맵일 가능성 (추측).
- `macro_type`: **2 = 일반 HID 키** (`macro_value` 가 usage), **12 = 특수 액션**
  (`macro_value` 1 = 미할당, 511 = FN1 레이어 전환) [db]

## 8. 기타 확인된 기능 [bin]

- 성능 프로파일 프리셋 (FPS swift/balanced, MOBA fast/balanced, Traditional)
- 매크로: 녹화, 반복 횟수, 지연 방식, 온보드 저장 공간 제한 있음
- 조명: 모드/밝기/속도/방향, 사용자 RGB 레이어, 뮤직 레이어, LED 애니메이션 프레임
- 폴링: `reporte_rate` 필드 존재 (원문 오타)
- "Normal Mode" / "Tachyon Mode" 전환 존재 — 의미 미확인
- 펌웨어 업데이트 후 **키 캘리브레이션 필수**, "Recalibrate" 명령 존재
- "Magnetic axis test module" — 자석축 테스트 화면 존재

## 9. 미해결 질문

- [ ] `0x06` 을 뺀 나머지 명령의 **데이터 배치**. 특히 키별 성능 설정을 쓰는 명령
- [ ] 아날로그 이벤트의 `payload[8]` 이 무엇인가 (래피드 트리거 기준점 추정)
- [ ] `payload[12..13]` 이 정확히 무엇인가 (주소가 아님 — 캘리브레이션 파라미터 추정)
- [ ] `payload[12..13]` 센서 주소의 체계
- [ ] 각 명령이 어떤 블롭을 대상으로 하는가 (§2.1 표의 크기로 추정만 됨)
- [ ] 총 스트로크가 정말 4.00mm(`0xc8`)인가
- [ ] **명령이 키를 HID usage 로 지정하나, `key_index` 로 지정하나?**
      Esc(41 vs 16) / A(4 vs 49) 한 번만 확인하면 갈립니다
- [ ] `0x02` 가 RAM 적용인가 플래시 저장인가
- [ ] 아날로그 스트리밍(자석축 테스트) 채널
- [ ] `fn_layer` 101 의 역할
- [ ] `perf_sensitivity_mode` / `perf_tachyon_mode` 의 의미

## 해결됨

- ~~장치 ID~~ → §1
- ~~통신 방식~~ → §1. FEATURE 가 아니라 **OUTPUT/INPUT 리포트**
- ~~패킷 프레임과 체크섬~~ → §2. 매직 `0x55`, 합 체크섬, ACK `0xAA`
- ~~명령 바이트 목록~~ → §3. 13종, 전부 하드웨어에서 응답 확인
- ~~응답 형식~~ → §3.1. 응답은 요청의 에코, `payload[0]` 만 `0xaa`
- ~~`0xa0` 의 정체~~ → §3.2. 아날로그 키 이벤트, 필드 전부 해독
- ~~실시간 키 깊이 채널~~ → §3.2. 읽기 전용, 61키 전부, 모니터 탭 동작
- ~~수정자 키가 인식되지 않던 문제~~ → §3.2. 8개 식별표 확정, 61키 전부 인식
- ~~총 스트로크~~ → 4.00 mm (200 카운트), 하드웨어 확인
- ~~블록 전송 형식~~ → §2.1. 길이 + 오프셋 + 56바이트 청크
- ~~`0xa9` 응답이 실시간 값인가~~ → §3.2. 상수임
- ~~키 매트릭스 매핑~~ → §6
- ~~`key_actuation` 정수 ↔ mm 스케일~~ → §4.1, 1 카운트 = 0.02 mm
- ~~설정 필드 목록~~ → §4.3, §4.4
- ~~레이어·프로파일 개수~~ → §7

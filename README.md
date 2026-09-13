# Raven61 Web Driver

## 개요

Raven61 및 Arbiter 계열 홀 이펙트 키보드용 브라우저 기반 설정 도구입니다. 

## 호환 확인된 키보드
### 아무런 수정 없이 바로 사용 가능한 키보드
- Teamwolf Raven61 HE

### 일부 수정 대응필요
- Luminkey magger68 HE Professional
  - 스위치 프로파일, 프로파일 대응 필요
- WCH CH32V 계열 사용하는 구 Arbiter 계열 키보드

## 실행

```bash
npm install
npm run dev
```

## 구조

```
src/
  hid/         WebHID 전송 계층 — 장치 핸들, 리포트 길이, 요청/응답 대응, 트래픽 로그
  protocol/    패킷 프레임, 이벤트 디코더, 코덱 엔진(스펙 → 코덱), 도메인 모델
  device/      보드 정의 — 스펙 타입·검사기·레지스트리, 기본 프로토콜(protocols/),
               내장 보드(boards/<board>/), 사용자 JSON(user/)
  keyboard/    HID 키코드 표, 수정자 지문 폴백
  demo/        데모 모드 — 가짜 HID 장치, 그 뒤의 시뮬레이션 보드, 87키 TKL 정의
  i18n/        문자열 번들과 번역 함수 — UI 문자열은 전부 여기에만 있습니다
  state/       연결·설정·선택 스토어
  tools/       리버스 엔지니어링 UI
  features/    설정 UI
```

## 디버그 모드 
**Shift 를 5번 빠르게** 누르면 켜지고, 같은 동작으로 꺼집니다. 

일반적으로는 필요하지 않는 기능이며 프로토콜을 해독할 사용합니다. 켜짐 여부는 `localStorage` 에 남으므로 브라우저를 닫아도
유지됩니다. 켜면 다음 탭이 추가로 생깁니다.

**인터페이스** — 키보드가 노출하는 HID 인터페이스 전부 표시 합니다. 평소에는 건들 필요 없으나 가끔 예상과 다른 인터페이스에 통신할 때 사용합니다.

**디버그** — 최상단에 실시간 모니터링이 고정되고, 그 아래 분석 패널과 **키 식별 폴백 스위치**, 그리고 도구가 서브탭으로 들어갑니다.

| 서브탭 | 내용 |
|--------|------|
| 탐색기 | 리포트 디스크립터 트리, 사용 가능한 리포트 ID와 길이 |
| 콘솔 | 프레임/블록 형식으로 명령 송신, 반복 전송 후 변하는 바이트 표시 |
| 프로버 | 실제 프레임(체크섬 자동)으로 명령을 스윕하고 응답 확인 |
| 이벤트 | 보드가 올려보내는 리포트 수신 + 센서 주소 연결 (기본 수신 전용, 스트림 켜기는 선택) |
| 로그 | 모든 송수신 기록, A/B 바이트 diff, TXT·JSON 내보내기 |

분석 패널: 관측된 식별자, 키 주소 후보, 기준 ADC 표류.

해당 탭에서 오가는 프로토콜을 보고 해독하면 됩니다.

## 프로토콜 작업
WCH CH32V 계열 사용하는 구 Arbiter 계열 키보드 기준으로 작성 되었습니다.
- 캡처 절차와 방법론: [docs/reverse-engineering.md](docs/reverse-engineering.md)
- 알아낸 내용 기록: [docs/protocol.md](docs/protocol.md)
- 추론 과정·증거 등급·틀렸던 결론: [docs/findings.md](docs/findings.md)

해당 툴은 오프라인 Windows 프로그램으로 배포되는 구 Arbiter 계열 드라이버를 위한 툴입니다.
- 명령 표 추출 (정적 분석): `python tools/bin/commands.py`
- 순정 DB 읽기/비교: `python tools/db/extract.py a.db --diff b.db`
- 런타임 추적: `frida -f "{Driver}" -l tools/frida/trace-hid.js`
- 캡처 변환/비교: `node tools/pcap/extract.mjs --diff a.pcapng b.pcapng`
- 레이아웃 재생성: `node tools/layout/from-vendor-xml.mjs`

해독한 명령은 보드 정의(`DeviceSpec`)의 `commands` 에 바이트로 적으면 됩니다.
프로토콜 계층은 그 스펙 하나로 코덱을 만들고, 구현된(= `null` 이 아닌) 명령만큼 UI가
자동으로 열립니다. 프레임 자체가 다른 보드라면 `KeyboardCodec`
(`src/protocol/codec.ts`)을 직접 구현해 같은 방식으로 등록합니다.

## 다른 키보드 대응하기

이 백엔드가 아는 것은 *보드 하나*가 아니라 **프로토콜 계열 하나**입니다 — 64바이트 벤더
프레임, 블록 전송, 8바이트 키별 성능 레코드, 3바이트 키맵 레코드. 보드마다 다른 것
— USB ID, 명령 번호, 블록 크기, 비트 위치, 키 배열, 스위치 목록 — 은 전부 데이터이고
`DeviceSpec` 한 값에 들어갑니다.

WCH CH32V 계열 사용하는 구 Arbiter 계열 다른 키보드를 지원하는 일은 **정의 파일 하나를 추가하고 빌드하는 것**이
전부입니다. `src/protocol/` 과 `src/features/` 는 수정할 필요가 없습니다.

- **TypeScript**: `src/device/boards/<board>/` 폴더를 만들고 `index.ts`(정의)·
  `layout.json`+`layout.ts`(키 표)·`switches.json`+`switches.ts`(스위치 표)·
  필요하면 `protocol.ts`(프로토콜)를 넣은 뒤
  `src/device/boards/index.ts` 의 `BUILT_IN_SPECS` 에 넣습니다. 타입 검사를 받습니다.
- **JSON**: `src/device/user/<board>.device.json` 에 같은 모양으로 씁니다. 빌드 때
  번들에 포함되고, 시작할 때 검사한 뒤 등록됩니다. 검사에 걸린 파일은 콘솔에 이유가
  찍히고 그 파일만 건너뜁니다.

적지 않은 항목은 Raven61 값을 물려받습니다(항목 단위로). 반드시 직접 적어야 하는
것은 `id` · `name` · `confidence` · `basedOn` · `usb` · `layout` 뿐입니다. 확인하지
못한 명령은 추측해서 넣지 말고 `null` 로 두세요 — 그 기능은 코덱에서 아예 빠지고,
패널이 "이 보드는 지원하지 않음"이라고 말합니다.

### 아직 해독되지 않은 키보드와 통신하기

정의가 없는 장치를 연결한 뒤 **인터페이스 패널**에서
*기본 프로토콜로 강제 통신* 을 켜면, 정의 없는 장치에도 기본 프로토콜을 그대로 보내
응답을 볼 수 있습니다.

- ⚠ 보내는 건 **해당 키보드가 아닌 다른 키보드의 명령**입니다. 예상하지 못한 결과가 나올 수 있으니 트래픽 로그를 열어 두고 읽기부터 하세요.
- 화면의 키 배열은 대체 표시이고 그 장치의 것이 아닙니다.
- 저장되지 않고 연결을 끊으면 해제됩니다. 매번 강제로 쓰는 건 지원이 아니라,
  정의를 쓸 만한 보드를 찾았다는 신호입니다.

자세한 절차와 각 필드를 무엇으로 확인해야 하는지는
[src/device/README.md](src/device/README.md) 에 있습니다.


## 다국어

화면에 보이는 문자열은 모두 `src/i18n/locales/*.json` 에 있습니다.

한국어(`ko.json`)가 기준 번들입니다. 키 목록은 이 파일에서 타입으로 뽑아내므로, 없는 키를
쓰면 컴파일이 실패하고, 번역에서 빠진 키는 한국어로 표시됩니다.

언어를 추가하려면:

1. `ko.json` 을 복사해 `src/i18n/locales/<코드>.json` 으로 두고 값만 번역합니다.
2. `src/i18n/index.ts` 의 `LOCALES` 에 한 줄, `BUNDLES` 에 한 줄 추가합니다.

번역문 안에서 사용가능한 것:

- `{name}` — 코드에서 넘기는 값
- `<b>…</b>` `<i>…</i>` `<c>…</c>` — 굵게 · 기울임 · 고정폭(코드·경로·바이트값)
- `<키>_one` / `<키>_other` — 수가 1일 때와 그 밖일 때를 나누는 언어용. 한국어처럼 필요
  없으면 `<키>` 하나만 두면 됩니다.

## 라이선스

```
Apache-2.0. 

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
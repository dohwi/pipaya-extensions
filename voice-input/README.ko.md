<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

# voice-input

[pipaya](https://github.com/dohwi/pipaya) 입력창의 마이크 버튼입니다. 누르고 말하고 다시 누르면 `mistral-support` CLIProxyAPI 플러그인을 거쳐 **Mistral Voxtral**이 받아써서 입력창에 붙여 넣습니다. 메시지를 대신 보내지는 않습니다.

| 녹음 중 | 완료 (390px, 다크) |
| :---: | :---: |
| <img src="docs/preview-recording.png" alt="녹음 중" width="100%" /> | <img src="docs/preview-mobile.png" alt="모바일" width="60%" /> |

## 필요한 것

- `mistral-support` 플러그인이 있는 CLIProxyAPI(`POST /v0/management/audio/transcriptions`)와 **관리 키**.
- **HTTPS**로 연 pipaya(마이크는 보안 컨텍스트에서만 켜집니다). 일반 `http://<ip>:<port>` 화면은 안 됩니다. 리버스 프록시나 `tailscale serve` 등으로 HTTPS로 제공하세요.
- pipaya가 HTTPS이면 **서버 주소도 HTTPS**여야 합니다(혼합 콘텐츠 차단). [서버 주소](#서버-주소-https) 참고.

## 설치

1. `npm run build` (또는 `dist/voice-input.json` 사용).
2. pipaya **설정 → 클라이언트 확장 → 확장 추가**에서 `dist/voice-input.json`을 가져옵니다(비활성으로 시작).
3. **Voice Input**을 열어 설정을 채우고 **설정 저장** 후 켜서 안내를 승인합니다.

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `apiBase` | *(필수, 없음)* | 내 CLIProxyAPI의 origin. 예: `https://your-cliproxyapi.example.com`. 경로나 계정 정보는 넣지 마세요. 내장된 주소는 없고, 비었거나 형식이 틀리면 버튼이 안내만 하고 요청을 보내지 않습니다. |
| `apiKey` | *(필수, 없음)* | 관리 키. 비밀 필드. 비어 있으면 버튼이 설정을 안내합니다. |
| `model` | `voxtral-mini-transcribe-3-0` | 비우면 서버 기본값. |
| `language` | `ko` | ISO 639-1 코드. 비우면 자동 감지. |

`settingsScope`는 **`local`**입니다. 관리 키는 자격 증명이라, `server` 범위면 pipaya 서버에 평문으로 저장되어 연결된 모든 기기에 공유됩니다. `local`이면 이 브라우저/앱에만 남고 내보내기에서도 빠집니다. 대신 기기마다 한 번 입력해야 합니다.

## 사용법

- 마이크를 누르면 녹음이 시작됩니다(빨간 버튼, 경과 시간). 다시 누르면(정지 ■) 변환합니다. **✕**는 업로드 없이 취소합니다.
- 결과는 기존 초안 뒤에 공백으로 이어 붙습니다. 확인하고 직접 전송하세요.
- 5분이 지나면 자동으로 멈춥니다. 녹음이 끝나면(버튼이 제거될 때도) 마이크를 바로 닫습니다.
- `context_bias`는 보내지 않습니다. 서버가 저장된 용어 목록(커밋, 푸시, git …)을 붙입니다.

| 표시 | 의미 |
| --- | --- |
| 주소 필요 | `apiBase`가 비었거나 http(s) origin이 아님(설정을 엽니다). |
| 키 필요 | 설정에 관리 키가 없음(설정을 엽니다). |
| 키 거부됨 | 401/403. 반복 실패 시 CLIProxyAPI의 IP 차단을 피하려고 키를 바꿀 때까지 다시 요청하지 않습니다. |
| 마이크 거부됨 / 마이크 없음 / 마이크 사용 불가 | 브라우저 사이트 설정에서 마이크 허용, 장치 확인, 다른 앱 종료. |
| HTTPS 필요 | pipaya가 보안 컨텍스트가 아님. |
| 연결 실패 / 시간 초과 | `apiBase`에 닿지 않음(60초 제한). |
| 인식 없음 / 너무 짧음 | 빈 결과, 또는 0.4초 미만 녹음. |

## 녹음 포맷

브라우저 `MediaRecorder`의 기본 포맷을 그대로 올립니다(Chrome/Firefox는 `audio/webm` opus, Safari는 `audio/mp4`). m4a, webm/opus, wav를 실제로 올려 모두 같은 결과가 나오는 것을 확인했으므로 WAV 변환은 하지 않습니다.

## 서버 주소 (HTTPS)

코어 수정은 필요 없습니다. pipaya **설정 → (서버 탭) → 편집**에서 주소를 `https://<내 pipaya 서버>:<포트>`로, 토큰은 그대로 두고 저장합니다(저장 전에 연결을 확인합니다). 목록은 이 브라우저의 `localStorage`(`pipaya.servers`)에 저장됩니다. 기본 주소는 페이지 호스트에 8787 포트 `http`로 만들어지므로, HTTPS 화면에서는 브라우저마다 한 번 바꿔야 합니다.

## 권한

| 권한 | 이유 |
| --- | --- |
| `ui-components` | 이것만 요청합니다. `composer.toolbar`에 버튼을 달기 위해서입니다. 마이크와 업로드는 컴포넌트가 직접 처리하므로(`getUserMedia`, `fetch`) `http`, `composer`, `storage`, `context` 권한은 요청하지 않습니다. |

> [!WARNING]
> `ui-components`는 이 확장의 Svelte 코드를 pipaya 앱 **안에서 샌드박스 없이** 실행하므로 앱이 가진 모든 것(대화, 서버 연결 정보, 토큰)에 접근할 수 있습니다. 키는 `apiBase`로 가는 `Authorization` 헤더로만 보내고 로그·다른 저장소·메시지에 넣지 않지만(테스트로 확인), 신뢰하는 빌드만 설치하세요.

## 개발

```sh
npm run check   # 빌드 + 단위 테스트
```

신뢰 컴포넌트는 `pipaya`와 `svelte*`만 import할 수 있어서, `scripts/build.mjs`가 `src/helpers.mjs`(순수 함수, 테스트됨)를 `src/components/VoiceButton.svelte`에 인라인합니다. 결과물은 `dist/voice-input.json`입니다.

## 라이선스

MIT

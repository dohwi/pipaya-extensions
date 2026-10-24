<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>quota-monitor</h1>
  <p>Claude · GPT · Antigravity 잔량을 <a href="https://github.com/dohwi/pipaya">pipaya</a> 상단 바에서 바로 확인하세요.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/cliproxyapi-plugin-quota-monitor"><img src="https://img.shields.io/badge/Requires-cliproxyapi--plugin--quota--monitor-0EA5E9?style=flat-square" alt="Requires cliproxyapi-plugin-quota-monitor" /></a>
  </p>
</div>

| 상단 바 게이지 | 마우스 오버 팝오버 |
| :---: | :---: |
| <img src="docs/preview-desktop.png" alt="상단 바 게이지" width="100%" /> | <img src="docs/preview-hover.png" alt="마우스 오버 팝오버" width="100%" /> |

## 무엇을 하나요

- pipaya 상단 바에 공급자별 원형 게이지를 하나씩 표시합니다: **Claude**, **GPT(Codex)**, **Antigravity**. 직접 연결한 Gemini 계정이 있으면 Gemini 게이지도 따로 나옵니다.
- 링은 CLIProxyAPI 서버가 계산한 **전체 잔량(%)** 입니다. 토큰이나 비용 추정치가 아닙니다.
- **Antigravity**는 이중 링입니다. 바깥 링은 Gemini, 안쪽 링은 Claude/GPT입니다.
- **가지고 있는 공급자만 표시합니다.** GPT 계정이 없으면 GPT 게이지는 나타나지 않습니다.
- 링 색상: 20% 초과는 공급자 고유 색, 20% 이하는 황색, 5% 이하는 적색입니다.
- 게이지에 마우스를 올리거나 포커스하면 잔량과 측정한 지 얼마나 지났는지 보입니다.
- 60초마다 자동 갱신하고, 에이전트가 한 턴을 끝내면 2.5초 뒤에 한 번 더 갱신합니다.
- 읽지 못했거나 알 수 없는 값은 0%로 표시하지 않습니다. 마지막 정상 값을 오래된 값으로 표시해 둡니다.

## 요구 사항

- [cliproxyapi-plugin-quota-monitor](https://github.com/dohwi/cliproxyapi-plugin-quota-monitor) 플러그인이 설치된 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 서버. Antigravity에서 Gemini 잔량을 보려면 v0.2.1 이상을 쓰세요.
- CLIProxyAPI **관리 키**
- 확장을 지원하는 pipaya 클라이언트 (SDK v1)

## 설치

1. 패키지를 준비합니다. 이 저장소의 `dist/quota-monitor.json`을 받거나 직접 빌드합니다([개발](#개발) 참고).
2. pipaya에서 **설정 → 확장 → 패키지 가져오기**를 열고 `dist/quota-monitor.json`을 선택합니다.
3. 설정을 입력하고 저장합니다:
   - **CLIProxyAPI 주소**: origin만 입력합니다. 예: `http://your-server:8317`. 경로나 계정 정보는 넣지 마세요.
   - **관리 키**: CLIProxyAPI 관리 키.
4. 요청 권한(`ui-components`, `http-write`, `events`)을 확인해 승인하고 **Quota Monitor**를 켭니다.

> [!WARNING]
> `ui-components`는 이 확장의 Svelte 게이지 코드를 **샌드박스 없이 pipaya 앱 안에서** 실행하므로 앱이 가진 모든 것(대화, 서버 연결, 토큰)에 접근할 수 있습니다. 폴링과 관리 키는 샌드박스 Worker 안에 남고, 그리는 코드는 네트워크·저장소에 접근하지 않지만(테스트로 검증) 신뢰하는 빌드만 설치하세요. 신뢰 UI를 지원하는 pipaya가 필요합니다.

몇 초 안에 상단 바에 게이지가 나타납니다.

> 설정은 pipaya 서버에 저장되어 모든 기기가 공유합니다. 확장을 켜는 것과 권한 승인은 기기마다 해야 합니다.
>
> 업데이트할 때는 새 `quota-monitor.json`을 같은 ID로 다시 가져오고, 새 권한이 있으면 승인하세요.

## 사용법

- **게이지 읽기**: 링이 찰수록 잔량이 많이 남은 것입니다. 회색이거나 비어 있으면 값을 알 수 없다는 뜻입니다.
- **자세히 보기**: 게이지에 마우스를 올리거나 키보드로 포커스하면 잔량과 `N초 전 업데이트됨`이 보입니다. Antigravity는 Gemini와 Claude/GPT 두 막대를 보여 줍니다.
- **오래된 값**: 서버에 연결하지 못하면 마지막 값을 유지하고 팝오버에 그 사실을 표시합니다. 연결이 돌아오면 저절로 회복됩니다.
- **즉시 갱신**: 에이전트가 턴을 끝내면 갱신됩니다. 수동 새로고침 버튼은 없습니다.

### 문제 해결

| 증상 | 원인과 해결 |
| --- | --- |
| "관리 키를 설정하세요" | 키가 비어 있습니다. 확장 설정에 입력하세요. |
| "관리 키가 거부되었습니다" | 키가 틀렸습니다(401/403). 키를 바꿀 때까지 요청을 멈춥니다. 반복 실패 시 서버가 IP를 일시 차단하는 것을 막기 위해서입니다. |
| "quota-monitor 설정을 확인하세요" | 서버에 플러그인은 있지만 설정이 안 되어 있습니다. |
| "첫 쿼터 수집을 기다리는 중" | 서버가 첫 수집 중입니다. 2초마다 다시 확인합니다. |
| 게이지가 미확인으로 나옴 | 서버에 해당 `availability` 값이 없습니다. quota-monitor 플러그인을 업데이트하세요. |
| GPT 게이지가 없음 | GPT(Codex) 계정이 없어서입니다. 의도된 동작입니다. |
| Antigravity에 Gemini 링이 없음 | quota-monitor 플러그인을 v0.2.1 이상으로 업데이트하세요. |

## 설정

| 설정 | 기본값 | 설명 |
| --- | :---: | --- |
| `httpOrigin` | *(필수)* | CLIProxyAPI의 origin. 예: `http://your-server:8317` |
| `httpToken` | *(필수)* | CLIProxyAPI 관리 키 |
| `language` | `auto` | `auto`는 프로그램 언어를 따릅니다. `ko` 또는 `en`으로 고정할 수 있습니다. |
| `pollSeconds` | 비어 있음 | 갱신 주기(초, 10~900). 비우면 서버 힌트(약 60초)를 따릅니다. |

## 보안

- 확장은 pipaya의 샌드박스 Worker에서 실행됩니다. 페이지, 앱 인증 토큰, 허용된 권한 밖의 것에는 접근할 수 없습니다.
- `GET <httpOrigin>/v0/management/plugins/quota-monitor/data/accounts`만 호출합니다. `Authorization: Bearer` 헤더는 호스트가 붙이므로 키가 URL이나 확장 코드에 나타나지 않습니다. 쿠키는 보내지 않고 리다이렉트는 거부합니다.
- `http-write` 권한은 SDK가 인증이 필요한 요청에 요구해서 받는 것입니다. 이 확장은 GET만 보냅니다.
- **관리 키는 평문으로 저장됩니다.** pipaya 서버의 `extensions/quota-monitor/settings.json`에 저장되고, 그 서버에 연결된 모든 기기가 받습니다. pipaya 서버 토큰이 있는 사람은 읽을 수 있습니다. 설정 내보내기에서는 제외됩니다. 기기를 분실하면 관리 키와 서버 토큰을 함께 교체하세요.
- 전체 잔량 비율만 사용합니다. 계정 이름, 이메일, 계정별 한도는 표시하지 않습니다.

## 동작 방식

```
공급자 → CLIProxyAPI + quota-monitor 플러그인 ──GET(관리 키)──▶ 이 확장 ──▶ pipaya 상단 바
```

플러그인이 모든 계정을 측정해 전체 잔량(`availability`: `claude`, `codex`, `antigravity_gemini`, `antigravity_claude`)을 집계합니다. 확장은 그 값을 링에 매핑할 뿐 다시 계산하지 않습니다.

## 개발

Node.js 26이 필요합니다(`mise install`로 설치).

```bash
npm run build   # src/를 dist/quota-monitor.json으로 번들
npm test        # Node 내장 테스트 러너
npm run check   # 빌드 + 테스트
```

소스 구성: `src/extension.js`(수명주기와 폴링), `src/model.mjs`(스냅샷 → 게이지), `src/view.mjs`(상단 바 노드), `src/i18n.mjs`(메시지), `src/logos.mjs`(브랜드 아이콘). `scripts/check-browser.cjs`는 선택 사항인 헤드리스 브라우저 QA 스크립트로, Playwright와 실행 중인 pipaya 클라이언트(`PIPAYA_TEST_URL`)가 필요합니다.

## 라이선스

[MIT](LICENSE) © 2026 dohwi

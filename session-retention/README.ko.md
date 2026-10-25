<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>session-retention</h1>
  <p>한동안 쓰지 않은 <a href="https://github.com/dohwi/pipaya">pipaya</a> 대화를 지웁니다. 기간을 정하기 전에는 꺼져 있습니다.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## 하는 일

- 서버는 대화를 스스로 지우지 않습니다. 이 확장이 그 기능을 더하며, 한 시간마다와 서버 시작 직후에 실행합니다.
- 설정 → 서버 확장 → Session Retention에서 켜거나(일수, 닫힌 채팅만), `PIPAYA_FLAG_RETENTION_DAYS=30`으로 켭니다(활성 대화를 남기려면 `PIPAYA_FLAG_RETENTION_ONLY_CLOSED=1`도). 또는 `setPolicy` 메서드에 `{enabled, days, onlyClosed}`를 보냅니다. 저장된 정책이 플래그보다 우선합니다.
- 메서드: `info`(정책, 마지막 실행, 지금 지울 개수), `setPolicy`, `run`(바로 정리).
- 실행 중이거나 답을 기다리는 대화는 나이와 상관없이 지우지 않습니다.

> 이전 pipaya 서버에는 이 기능이 내장되어 있었습니다(설정 → 대화 → 자동 삭제). 계속 쓰려면 이 확장을 설치하고 기간을 다시 정하세요.

## 요구 사항

- `pi.sessions`가 있는 pipaya 서버 (커밋 936bab8 이후, 0.3.7 다음 릴리스부터).

## 설치

pipaya의 **설정 → 확장 → 마켓플레이스**에서 **session-retention** 확장을 설치하세요. 서버가 고정된 릴리스를 `~/.pipaya/extensions/session-retention/`에 받아 다시 불러옵니다.

직접 설치: 이 폴더를 `~/.pipaya/extensions/session-retention/`에 복사하고 다시 불러오세요(`POST /server-extensions/reload` 또는 설정 → 확장). 끄려면 폴더를 지우고 다시 불러옵니다.

## 보안

- 서버 확장은 서버의 모든 권한으로 실행됩니다. 설치 전에 `index.ts`를 읽어 보세요.
- 대화를 **영구 삭제**합니다. 세션 메타데이터만 읽고(메시지는 읽지 않음), 명령을 실행하지 않고 네트워크를 쓰지 않습니다. 정책은 확장 설정에, 마지막 실행 기록은 자신의 데이터 폴더에 저장합니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 빌드 단계는 없습니다. pipaya 서버에 로드해 확인합니다(`/server-extensions`에 `error` 없이 보여야 합니다).

## 라이선스

[MIT](LICENSE)

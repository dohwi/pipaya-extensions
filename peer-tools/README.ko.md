<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>peer-tools</h1>
  <p><a href="https://github.com/dohwi/pipaya">pipaya</a>의 에이전트끼리 서로의 대화에 메시지를 보내고 읽게 하세요.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## 하는 일

- `peer_send`를 추가합니다. 다른 활성 대화에 `@이름`으로, 그룹이면 `@그룹` 핸들로 그 그룹의 다른 모든 대화에 메시지를 보냅니다. 받은 쪽은 독립적으로 일하고, 요청받을 때만 답합니다.
- `peer_read`를 추가합니다. 다른 대화의 최근 메시지를 텍스트로 읽습니다.
- 한 번의 실행에서 `peer_send`는 최대 10번이라 두 대화가 끝없이 서로 답하지 않습니다. `peer_read` 출력에도 길이 제한이 있습니다.
- 설정 → 도구에서 끌 수 있습니다.

> 이 확장이 생기기 전에는 같은 기능이 서버에 내장되어 있었습니다. 계속 쓰려면 설치하세요.

## 요구 사항

- `pi.sessions`, `pi.groups`와 도구 옵션 `alwaysActive`/`switchable`이 있는 pipaya 서버 (커밋 936bab8 이후, 0.3.7 다음 릴리스부터).

## 설치

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install peer-tools        #  ~/.pipaya/extensions/peer-tools 로 복사
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

또는 이 폴더(`peer-tools`)를 `~/.pipaya/extensions/peer-tools/`에 복사하고 reload 하세요. 끄려면 폴더를 지우고 reload 합니다.

## 보안

- 서버 확장은 서버의 모든 권한으로 실행됩니다. 설치 전에 `index.ts`를 읽어 보세요.
- 다른 대화의 메시지를 읽고, 그 대화에 메시지를 보낼 수 있습니다(받은 에이전트가 일하게 됩니다). 파일을 읽지 않고, 명령을 실행하지 않고, 네트워크를 쓰지 않습니다. 아무것도 저장하지 않습니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 빌드 단계는 없습니다. pipaya 서버에 로드해 확인합니다(`/server-extensions`에 `error` 없이 보여야 합니다).

## 라이선스

[MIT](LICENSE)

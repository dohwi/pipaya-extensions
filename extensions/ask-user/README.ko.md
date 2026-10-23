<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>ask-user</h1>
  <p>에이전트가 추측하지 않고 <a href="https://github.com/dohwi/pipaya">pipaya</a>에서 멈추고 질문하게 하세요.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## 기능

- `ask_user` 도구를 추가합니다. 에이전트가 질문 하나, 또는 여러 개를 한꺼번에(탭으로 표시, 보내기 전에 답을 고칠 수 있음) 묻고 답을 기다립니다.
- 선택지(`options`), 추천 항목(`recommended`), 자유 입력 허용 여부(`allowFreeText`)를 쓸 수 있습니다.
- 기다리는 동안 비용이 들지 않고 시간 제한도 없습니다. 실행을 중단하면 질문이 해제됩니다.
- 예전 내장 도구와 이름이 같아 기존 대화와 클라이언트의 질문 카드가 그대로 동작합니다.

## 요구 사항

- 서버 확장용 `ctx.ask`가 있는 pipaya 서버 (`ask_user`를 서버에서 분리한 버전 이상).

## 설치

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install ask-user        # ~/.pipaya/extensions/ask-user 로 복사
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

또는 `extensions/ask-user` 폴더를 `~/.pipaya/extensions/ask-user/`에 복사하고 reload 하세요. 끄려면 폴더를 지우고 reload 합니다. 확장이 없으면 에이전트는 묻지 않고 가정하고 진행합니다.

## 보안

- 서버 확장은 서버의 모든 권한으로 실행됩니다. 이 확장은 약 40줄이니 `index.ts`를 직접 읽어 보세요.
- 파일을 읽지 않고, 명령을 실행하지 않고, 네트워크를 쓰지 않습니다. 질문과 답은 서버의 질문 채널(`ctx.ask`)만 지나갑니다.
- 아무것도 저장하지 않으며, 일반 질문 카드 이벤트 외에는 다른 클라이언트로 보내지 않습니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 빌드 단계는 없고 확장은 `index.ts` 하나입니다. pipaya의 `server/test/api.test.ts`가 사본을 로드해 검증합니다.

## 라이선스

[MIT](LICENSE)

<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>pipaya-extensions</h1>
  <p><a href="https://github.com/dohwi/pipaya">pipaya</a> 확장 모음입니다. 확장마다 폴더 하나이고, <a href="https://github.com/dohwi/pipaya-marketplace">마켓플레이스</a>에서 설치합니다.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
    <a href="https://bun.sh" target="_blank" rel="noreferrer"><img src="https://img.shields.io/badge/Bun-1.3-000000?style=flat-square&logo=bun&logoColor=white" alt="Bun" /></a>
  </p>
</div>

> [!WARNING]
> 서버 확장은 **서버의 모든 권한으로** 실행됩니다. 설치하기 전에 코드와 폴더의 README를 꼭 읽어 보세요.

## 확장

| 폴더 | 종류 | 설명 |
|---|---|---|
| [ask-user](extensions/ask-user) | server | 에이전트가 선택지·추천과 함께 질문하고 답을 기다리게 함 |
| [guard](extensions/guard) | server | 위험한 셸 명령(`rm -rf /`, `mkfs`, 포크 폭탄)을 실행 전에 차단 |
| [peer-tools](extensions/peer-tools) | server | 에이전트가 서로의 대화에 메시지를 보내고(`peer_send`) 읽게 함(`peer_read`) |
| [prompt-templates](extensions/prompt-templates) | server | 긴 프롬프트를 Markdown 파일로 저장해 `/prompt:이름`으로 호출 |
| [session-retention](extensions/session-retention) | server | 한동안 쓰지 않은 대화를 자동 삭제(기본은 꺼짐) |
| [quota-monitor](extensions/quota-monitor) | client | Claude, GPT, Antigravity 잔량 게이지를 navbar에 표시 |

## 설치

폴더마다 마켓플레이스에 따로 등록되어 있어서, 필요한 것만 설치합니다.

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install peer-tools     # extensions/peer-tools 를 ~/.pipaya/extensions/ 로 복사
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

클라이언트 확장(`quota-monitor`)은 pipaya 앱의 **설정 → 확장 → 마켓플레이스**에서 설치합니다.

## 구조

```
pipaya-extensions/
└── extensions/<id>/       # 확장 하나: index.ts + package.json (서버), 또는 manifest.json + dist/<id>.json (클라이언트)
    ├── package.json       # name, version, description, license, author, pipaya.title
    ├── README.md          # 무엇을 읽고, 실행하고, 보내는지
    └── tests/             # 선택
```

## 확장 추가·업데이트

1. `extensions/<id>/`를 추가하거나 고칩니다. 서버 확장에는 `index.ts`와 `package.json`이 필요하고, README에 무엇을 읽고 실행하고 보내는지 적어야 합니다.
2. `package.json`의 `version`을 올립니다.
3. 릴리스 태그를 `<id>-v<버전>`으로 만듭니다(예: `peer-tools-v0.2.0`). 확장마다 태그가 따로라서 폴더별로 버전이 독립적입니다.
4. [pipaya-marketplace](https://github.com/dohwi/pipaya-marketplace)에서 `bun scripts/pin.ts <id> <태그>`를 실행하고 결과를 커밋합니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 서버 확장에는 빌드 단계가 없습니다. 실행 중인 pipaya 서버가 필요한 테스트는 `PIPAYA_APP=<pipaya>/server`를 읽습니다.

```bash
bun scripts/check.ts                          # 전체: package.json 유효성, 진입 파일, 서버가 필요 없는 테스트
PIPAYA_APP=~/pipaya/app/server bun scripts/check.ts peer-tools   # 확장 하나, 서버 테스트 포함
```

## 라이선스

[MIT](LICENSE)

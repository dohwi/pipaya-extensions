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
| [ask-user](ask-user) | server | 에이전트가 선택지·추천과 함께 질문하고 답을 기다리게 함 |
| [guard](guard) | server | 위험한 셸 명령(`rm -rf /`, `mkfs`, 포크 폭탄)을 실행 전에 차단 |
| [peer-tools](peer-tools) | server | 에이전트가 서로의 대화에 메시지를 보내고(`peer_send`) 읽게 함(`peer_read`) |
| [prompt-templates](prompt-templates) | server | 긴 프롬프트를 Markdown 파일로 저장해 `/prompt:이름`으로 호출 |
| [image-generation](image-generation) | server | 연결의 이미지 모델 실행: 대화에서 그림을 설명하면 답이 그림으로 옴 |
| [peer-names](peer-names) | client | `@이름` 라벨, `@` 자동완성, 대화 간 메시지 말풍선 (peer-tools와 함께 사용) |
| [quota-monitor](quota-monitor) | client | Claude, GPT, Antigravity 잔량 게이지를 상단 바에 표시 |

## 설치

pipaya의 **설정 → 확장 → 마켓플레이스**에서 설치합니다. 폴더마다 따로 등록되어 있어 필요한 것만 고르면 됩니다. 서버 확장은 서버가 고정된 릴리스를 받아 오고, 클라이언트 확장은 기기에 설치됩니다. 짝이 있는 확장(peer-tools + peer-names)은 함께 설치할지 묻습니다.

## 구조

```
extensions/                # 이 저장소 (dohwi/pipaya-extensions)
└── <id>/                  # 확장 하나: index.ts + package.json (서버), 또는 manifest.json + dist/<id>.json (클라이언트)
    ├── package.json       # name, version, description, license, author, pipaya.title
    ├── README.md          # 무엇을 읽고, 실행하고, 보내는지
    └── tests/             # 선택
```

## 확장 추가·업데이트

1. `<id>/`를 추가하거나 고칩니다. 서버 확장에는 `index.ts`와 `package.json`이 필요하고, README에 무엇을 읽고 실행하고 보내는지 적어야 합니다.
2. `package.json`의 `version`을 올립니다(클라이언트 확장은 `manifest.json`도 올리고 `dist/`를 다시 빌드).
3. 릴리스 태그를 `<id>-v<버전>`으로 만듭니다(예: `peer-tools-v0.2.0`). 확장마다 태그가 따로라서 폴더별로 버전이 독립적입니다.
4. [pipaya-marketplace](https://github.com/dohwi/pipaya-marketplace)에서 `bun scripts/pin.ts <id> <태그>`를 실행하고 결과를 커밋합니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 서버 확장에는 빌드 단계가 없습니다. 실행 중인 pipaya 서버가 필요한 테스트는 `PIPAYA_APP=<pipaya>/server`를 읽습니다. 보통 이 저장소를 `app/`(pipaya), `marketplace/` 옆에 `extensions/`로 둡니다.

```bash
bun scripts/check.ts                          # 전체: package.json 유효성, 진입 파일, 서버가 필요 없는 테스트
PIPAYA_APP=../app/server bun scripts/check.ts peer-tools   # 확장 하나, 서버 테스트 포함
```

## 라이선스

[MIT](LICENSE)

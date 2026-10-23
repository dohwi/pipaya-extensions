<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>prompt-templates</h1>
  <p>긴 프롬프트를 Markdown 파일로 저장해 두고 <a href="https://github.com/dohwi/pipaya">pipaya</a>에서 <code>/prompt:이름</code>으로 부르세요.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## 하는 일

- `/prompt:이름 나머지 입력`은 템플릿의 본문으로 바뀌어 모델에 전달됩니다. `$ARGUMENTS`는 이름 뒤에 입력한 내용으로 바뀌고, 없으면 인자를 본문 끝에 붙입니다.
- 템플릿은 `~/.agents/templates`(전역) 또는 대화 폴더에서 저장소 루트까지의 `.agents/templates`(프로젝트)에 있는 `<이름>.md` 파일입니다. frontmatter로 `description`, `name`을 줄 수 있습니다.
- 입력한 짧은 호출은 메시지 아래 메모로 보이고, 대화 제목은 템플릿 이름이 됩니다.
- 클라이언트의 슬래시 메뉴와 하단 배지가 쓰는 `list` 메서드를 추가합니다.

> 이 확장이 생기기 전에는 같은 기능이 서버에 내장되어 있었습니다. 계속 쓰려면 설치하세요.

## 요구 사항

- `input` 훅이 `parts`, `title`을 지원하는 pipaya 서버 (커밋 936bab8 이후, 0.3.7 다음 릴리스부터). 이 확장이 없으면 클라이언트는 템플릿 메뉴와 배지를 숨깁니다.

## 설치

```bash
git clone https://github.com/dohwi/pipaya-marketplace && cd pipaya-marketplace
bun scripts/market.ts install prompt-templates        #  ~/.pipaya/extensions/prompt-templates 로 복사
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://<server>/server-extensions/reload
```

또는 이 폴더(`prompt-templates`)를 `~/.pipaya/extensions/prompt-templates/`에 복사하고 reload 하세요. 끄려면 폴더를 지우고 reload 합니다.

## 보안

- 서버 확장은 서버의 모든 권한으로 실행됩니다. 설치 전에 `index.ts`를 읽어 보세요.
- 두 템플릿 폴더의 `.md` 파일(최대 200개, 파일당 128 KB)만 읽습니다. 명령을 실행하지 않고 네트워크를 쓰지 않습니다. 아무것도 저장하지 않습니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 빌드 단계는 없습니다. `bun test`로 템플릿 파서 단위 테스트를 돌립니다.

## 라이선스

[MIT](LICENSE)

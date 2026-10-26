<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

<div align="center">
  <h1>image-generation</h1>
  <p><a href="https://github.com/dohwi/pipaya">pipaya</a> 대화에서 그림을 만들고 고칩니다.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" /></a>
    <a href="https://github.com/dohwi/pipaya-marketplace"><img src="https://img.shields.io/badge/Listed_in-pipaya--marketplace-F08A24?style=flat-square" alt="pipaya-marketplace" /></a>
  </p>
</div>

## 하는 일

- 설정한 모델들(기본 `google/gemini-3.1-flash-image`)로 **Image generation** 모델 제공자를 추가합니다.
- 대화에서 이 모델을 고르면 메시지마다 그림 요청이 되고, 답은 그림입니다. 첨부한 그림도 함께 보냅니다.
- 그림은 대화 폴더의 `.pipaya/generated/`에 저장되고 대화에는 마크다운 이미지로 보입니다.
- 그림 없이 이어서 보내면("더 파랗게") 마지막에 만든 그림을 함께 보내 모델이 그것을 고칩니다.
- 도구와 추론은 쓰지 않고 그림만 그립니다.

## 설정

설정 → 서버 확장 → Image Generation:

| 항목 | 의미 |
|---|---|
| API 키 | 엔드포인트의 키 (서버의 확장 설정에 저장) |
| 엔드포인트 | 이미지 출력을 지원하는 chat completions 주소. 비우면 `https://openrouter.ai/api/v1` |
| 모델 | 쉼표로 구분한 모델 ID |

## 요구 사항

- 이미지 생성이 코어에서 빠진(이 확장으로 옮겨진) pipaya 서버.

## 설치

pipaya에서 **설정 → 확장 → 마켓플레이스**를 열고 **image-generation**을 설치합니다. 서버가 고정된 릴리스를 `~/.pipaya/extensions/image-generation/`에 받아 다시 불러옵니다.

## 보안

- 서버 확장은 서버의 모든 권한으로 실행됩니다. 설치 전에 `index.ts`를 읽어 보세요.
- 메시지 글, 첨부한 그림, 마지막으로 만든 그림을 설정한 엔드포인트에 API 키와 함께 보냅니다. 그 밖에는 보내지 않습니다.
- 그림 파일은 대화 폴더의 `.pipaya/generated/` 아래에만 쓰고, 그곳에 자신이 링크한 그림만 다시 읽습니다.

## 개발

[Bun](https://bun.sh)이 필요합니다(`mise install`). 빌드 단계는 없습니다.

```bash
bun test                                # 순수 함수
PIPAYA_APP=../../app/server bun test    # 가짜 엔드포인트로 pipaya 서버에 올려 확인
```

## 라이선스

[MIT](LICENSE)

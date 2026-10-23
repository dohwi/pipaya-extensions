<p align="center"><a href="README.md">English</a> · <b>한국어</b></p>

# peer-names

[pipaya](https://github.com/dohwi/pipaya)의 클라이언트 확장입니다. 다른 대화를 `@이름`으로 부르는 것과 관련된 화면을 전부 그립니다.

- 사이드바와 대화 헤더의 제목 앞 `@이름` 라벨
- 입력창의 `@이름` / `@그룹` 자동완성과 강조
- 다른 대화가 `peer_send`로 보낸 메시지 말풍선

pipaya 코어는 이 이름들을 모릅니다. 이 확장이 없으면 아무것도 표시되지 않습니다.

## 필요한 것

서버 확장 [peer-tools](../peer-tools)도 함께 설치하세요. `peer_send`, `peer_read`, 에이전트용 멘션 힌트, 이 확장이 읽는 `overview` 메서드를 제공합니다.

## 권한

`server`(peer-tools의 overview 읽기), `events`, `session-labels`, `composer-mentions`, `messages`.

## 빌드

```bash
npm run check   # dist/peer-names.json을 만들고 테스트를 실행합니다
```

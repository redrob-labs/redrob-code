---
name: browser-kakao
description: 브라우저에서 카카오 웹 서비스(다음 메일, 카카오맵, 카카오 계정)를 쓸 때 쓴다.
urls:
  - https://*.kakao.com/*
  - https://mail.daum.net/*
  - https://map.kakao.com/*
keywords:
  - 카카오
  - 다음 메일
  - 카카오맵
  - kakao
---

# 카카오 (웹)

도구: `open_page`, `read_page`, `click`, `type_text`, 그리고 제공될 때 `login`.

카카오톡 대화는 웹에서 열리지 않는다. 대화 내용을 찾아 달라는 요청이면 브라우저로는 할 수 없다고
말한다.

- 다음 메일: `https://mail.daum.net/`을 연다. 로그인 화면이면 `login`(있을 때)을 쓰거나 사용자에게
  로그인을 부탁한다. 검색은 상단 검색 칸에 `type_text`, 메일은 제목을 `click`한 뒤 `read_page`.
  답장은 초안만 쓰고 "보내기"는 요청받았을 때만 누른다.
- 카카오맵: `https://map.kakao.com/?q=<검색어>`로 바로 연다. `read_page`로 장소 이름, 주소, 영업시간,
  전화번호를 읽고, 길찾기는 장소를 `click`한 뒤 "길찾기"를 누른다.
- 카카오 계정 설정(`https://accounts.kakao.com/`)은 읽기만 한다. 비밀번호, 연결된 서비스, 보안 설정은
  바꾸지 않는다.

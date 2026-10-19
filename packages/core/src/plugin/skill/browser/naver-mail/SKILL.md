---
name: browser-naver-mail
description: 브라우저에서 네이버 메일을 읽거나 검색하거나 답장 초안을 쓸 때 쓴다.
urls:
  - https://mail.naver.com/*
keywords:
  - 네이버 메일
  - 네이버메일
  - naver mail
---

# 네이버 메일

도구: `open_page`, `read_page`, `click`, `type_text`, 그리고 제공될 때 `login`.

1. `open_page`로 `https://mail.naver.com/`을 연다. `read_page`에 로그인 화면이 보이면 `login`이
   있을 때 그것을 쓰고, 없으면 사용자에게 로그인을 부탁하고 멈춘다. 비밀번호를 직접 입력하지 않는다.
2. 메일을 찾을 때는 상단 "메일 검색" 칸에 `type_text`로 보낸 사람이나 제목 단어를 넣고 검색을 누른다.
3. `read_page`는 목록을 보낸 사람, 제목, 날짜 순으로 준다. 제목을 `click`해서 열고 다시 `read_page`로
   본문을 읽는다.
4. 답장은 "답장"을 누르고 본문에 `type_text`로 초안만 쓴 뒤 멈춘다. 사용자가 그 내용을 보내라고 하지
   않았으면 "보내기"를 누르지 않는다.

메일 삭제, 스팸 처리, 폴더 이동은 사용자가 이름을 들어 요청할 때만 한다.

---
name: browser-naver-search
description: 네이버에서 검색해 국내 정보(가게, 뉴스, 블로그 후기, 지식iN, 쇼핑 가격)를 찾을 때 쓴다.
urls:
  - https://search.naver.com/*
  - https://www.naver.com/*
keywords:
  - 네이버 검색
  - 네이버에서
  - 네이버로 찾아
---

# 네이버 검색

도구: `open_page`, `read_page`, `click`.

1. 검색창을 거치지 말고 URL로 바로 연다:
   `https://search.naver.com/search.naver?query=<검색어>`.
   탭을 좁히려면 `&where=news`(뉴스), `&where=blog`(블로그), `&where=kin`(지식iN)을 붙인다.
   지도·가게 정보는 `https://map.naver.com/p/search/<검색어>`.
2. `read_page`로 결과의 제목, 출처, 날짜, 요약을 읽는다. 광고(파워링크) 결과는 따로 표시하거나 뺀다.
3. 답에 쓸 결과는 `click`해서 원문을 열고 `read_page`로 확인한 뒤 인용한다. 요약만 보고 단정하지 않는다.
4. 답에는 출처 링크와 글 날짜를 함께 적는다. 블로그 후기는 개인 의견이라고 밝힌다.

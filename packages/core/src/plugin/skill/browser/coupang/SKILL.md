---
name: browser-coupang
description: 쿠팡 주문 내역과 배송 상태를 조회할 때 쓴다. 주문, 결제, 취소, 반품은 하지 않는다.
urls:
  - https://www.coupang.com/*
  - https://mc.coupang.com/*
keywords:
  - 쿠팡
  - coupang
  - 주문 내역
  - 배송 조회
---

# 쿠팡 주문 조회

도구: `open_page`, `read_page`, `click`, 그리고 제공될 때 `login`.

1. `open_page`로 주문 목록 `https://mc.coupang.com/ssr/desktop/order/list`를 연다. 로그인 화면이면
   `login`(있을 때)을 쓰거나 사용자에게 로그인을 부탁하고 멈춘다.
2. `read_page`는 주문마다 주문일, 상품명, 금액, 배송 상태를 준다. 오래된 주문은 화면의 연도 탭을
   `click`해서 넘긴다.
3. 배송 상세는 해당 주문의 "배송조회"를 `click`한 뒤 `read_page`로 택배사, 운송장 번호, 현재 위치를
   읽는다.
4. 답에는 주문일, 상품명, 상태를 표처럼 정리한다.

"구매하기", "결제", "주문취소", "반품신청", "교환신청"은 누르지 않는다. 사용자가 원하면 해당 화면을
열어 두고 직접 누르도록 안내한다.

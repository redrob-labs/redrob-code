/*
 * The tuning slice: first messages written the way the evaluation set is (a detailed, briefed request
 * and a terse one for each task, in both registers), but kept apart from both it and the training set.
 *
 * The classifier never trains on these. They choose what the training set cannot: the confidence
 * floor, which is only meaningful on messages that look like real use, and which pairs of kinds of
 * work are still confused. The evaluation set stays untouched until the final score.
 */
import type { TrainingExample } from "./index.js";

type Rows = { en: readonly string[]; ko: readonly string[] };

const BY_ACTION: Record<string, Rows> = {
  reply: {
    en: [
      "Ticket below: customer was billed after cancelling. Write a reply that confirms the refund of $49, says it lands in 3-5 days, and apologises once. Under 100 words.",
      "help me reply to this customer, they can't find the export button",
      "An admin says the new permissions update locked half their team out. Draft my response as support lead: acknowledge, explain the rollback we did at 2pm, and offer a call. No more than three paragraphs.",
      "write back to the user who reported the calendar sync bug",
    ],
    ko: [
      "해지했는데 결제가 됐다는 고객 티켓이에요. 49달러 환불을 확인하고 3~5일 안에 들어간다고 안내하는 답장을 써 주세요. 사과는 한 번만, 200자 이내로요.",
      "내보내기 버튼을 못 찾겠다는 고객 문의에 답변 좀 써줘",
      "권한 업데이트 이후 팀원 절반이 접속을 못 한다고 관리자가 항의했어요. 고객지원 리드로서 상황을 인정하고, 오후 2시에 롤백한 내용을 설명하고, 통화를 제안하는 답장을 세 문단 이내로 써 주세요.",
      "캘린더 동기화 버그 신고한 사용자한테 답장해줘",
    ],
  },
  summ: {
    en: [
      "Here's a 40-message support thread with Lumen Foods. Summarise it for the account manager: the problem, what we tried, what's still open, and who owes the next step. Five bullets max.",
      "summarize my notes from the call with the Harbor team",
      "Turn this week's activity on our top 10 accounts into a digest for the sales channel: one line per account, flag anything at risk in bold.",
      "tl;dr this ticket history please",
    ],
    ko: [
      "루멘푸드와 주고받은 40개짜리 지원 스레드예요. 담당 영업에게 전달할 수 있게 문제, 시도한 조치, 남은 이슈, 다음 담당자를 다섯 줄 이내로 요약해 주세요.",
      "하버팀이랑 한 통화 메모 정리해줘",
      "이번 주 상위 10개 고객사 동향을 영업 채널에 올릴 다이제스트로 만들어 주세요. 고객사별 한 줄씩, 위험 신호는 굵게 표시해 주세요.",
      "이 티켓 히스토리 요약 좀",
    ],
  },
  email: {
    en: [
      "Write a renewal email to Northwind's CFO. Their contract ends March 31; mention the 8% price increase, the usage growth that justifies it, and offer a 15-minute call. Keep it under 150 words.",
      "draft a follow-up email after yesterday's demo with Kestrel",
      "Write a first cold email to the head of operations at a mid-size logistics company. One sentence on the pain, one on what we do, one ask. No buzzwords.",
      "email the prospect from the webinar and ask for a meeting",
    ],
    ko: [
      "노스윈드 CFO에게 보낼 갱신 메일을 써 주세요. 계약이 3월 31일에 끝나고, 8% 인상과 그 근거가 되는 사용량 증가를 언급하고, 15분 통화를 제안해 주세요. 300자 이내로요.",
      "어제 케스트럴 데모 끝나고 보낼 팔로업 메일 써줘",
      "중견 물류회사 운영 총괄에게 보낼 첫 콜드메일을 써 주세요. 문제 한 문장, 우리가 하는 일 한 문장, 요청 한 문장. 유행어는 빼고요.",
      "웨비나 참석한 잠재고객한테 미팅 요청 메일 보내줘",
    ],
  },
  research: {
    en: [
      "Before Thursday's meeting with Brightline Health, put together an account brief: what they do, recent news, who the decision makers are, and two angles for our pitch. One page.",
      "look up what our three main competitors charge for their team plans",
      "Scan how Asana, Monday and ClickUp position AI features on their pricing pages and summarise the differences in a table.",
      "find out who runs procurement at Delmar Group",
    ],
    ko: [
      "목요일 브라이트라인헬스 미팅 전에 어카운트 브리프를 만들어 주세요. 사업 내용, 최근 뉴스, 의사결정권자, 제안 포인트 두 가지를 한 페이지로요.",
      "주요 경쟁사 세 곳 팀 요금제 가격 좀 찾아줘",
      "아사나, 먼데이, 클릭업이 요금제 페이지에서 AI 기능을 어떻게 내세우는지 조사해서 차이를 표로 정리해 주세요.",
      "델마그룹 구매 담당자가 누군지 알아봐줘",
    ],
  },
  analyze: {
    en: [
      "Attached is the Q3 pipeline export. Tell me which deals over $50k have slipped more than once, and what share of the quarter's forecast they make up. Show the numbers.",
      "why did churn jump in August? data's in the sheet",
      "Check this forecast against the last four quarters' actual close rates and tell me if the commit number is realistic, with the math.",
      "break down signups by channel for the last 6 months",
    ],
    ko: [
      "첨부한 3분기 파이프라인 데이터에서 5만 달러 이상 딜 중 두 번 이상 밀린 건이 뭔지, 그게 분기 예측의 몇 퍼센트인지 숫자와 함께 알려 주세요.",
      "8월에 이탈률이 왜 뛰었는지 봐줘, 데이터는 시트에 있어",
      "이 예측치를 지난 4분기 실제 성사율과 비교해서 커밋 숫자가 현실적인지 계산 과정과 함께 판단해 주세요.",
      "최근 6개월 가입자를 채널별로 나눠서 분석해줘",
    ],
  },
  code: {
    en: [
      "Add a GET /api/projects/:id/members endpoint that returns members with their role, paginated 50 at a time. Follow the pattern in routes/teams.ts and include the OpenAPI annotation.",
      "build a date range picker component for the reports page",
      "Write the migration that moves user preferences from the JSON column into their own table, with a backfill and a down migration.",
      "implement CSV import for contacts",
    ],
    ko: [
      "프로젝트 멤버를 역할과 함께 50명씩 페이지로 돌려주는 GET /api/projects/:id/members 엔드포인트를 추가해 주세요. routes/teams.ts 패턴을 따르고 OpenAPI 주석도 넣어 주세요.",
      "리포트 페이지에 쓸 날짜 범위 선택 컴포넌트 만들어줘",
      "사용자 설정을 JSON 컬럼에서 별도 테이블로 옮기는 마이그레이션을 백필과 롤백까지 포함해서 작성해 주세요.",
      "연락처 CSV 가져오기 기능 구현해줘",
    ],
  },
  fix: {
    en: [
      "The checkout test in cart.spec.ts started failing after the currency change. Find the cause and fix the code, not the test, unless the test is wrong. Explain which it was.",
      "prod is throwing 500s on /login since the deploy, fix it",
      "Users in Seoul see yesterday's date on the dashboard. Track down the timezone bug and patch it.",
      "this function returns undefined sometimes, figure out why",
    ],
    ko: [
      "통화 변경 이후 cart.spec.ts의 결제 테스트가 깨졌어요. 원인을 찾아서 코드를 고쳐 주세요. 테스트가 잘못된 거면 그렇다고 말해 주시고요.",
      "배포 이후 운영에서 /login이 500 에러 나, 고쳐줘",
      "서울 사용자 대시보드에 어제 날짜가 보여요. 시간대 버그 찾아서 수정해 주세요.",
      "이 함수가 가끔 undefined를 반환하는데 왜 그런지 찾아줘",
    ],
  },
  review: {
    en: [
      "Review PR #212 before I merge it. Focus on the locking in the job queue and anything that could double-charge a customer. Comment inline, and say whether it's safe to ship.",
      "take a look at my teammate's pull request and leave comments",
      "Go through this diff for security problems: SQL built from strings, missing auth checks, secrets in logs. List each with the line.",
      "can you review the changes in this branch",
    ],
    ko: [
      "머지 전에 PR #212를 리뷰해 주세요. 작업 큐의 락 처리와 고객 이중 결제 가능성을 중심으로 인라인 코멘트를 남기고 배포해도 되는지 판단해 주세요.",
      "동료 풀리퀘스트 보고 코멘트 남겨줘",
      "이 diff에서 문자열로 만든 SQL, 빠진 권한 체크, 로그에 남는 비밀값 같은 보안 문제를 줄 번호와 함께 찾아 주세요.",
      "이 브랜치 변경사항 리뷰해줘",
    ],
  },
  test: {
    en: [
      "Write unit tests for the discount calculator in pricing/discount.ts: cover stacking, the 100% cap, expired codes and rounding to cents. Use the existing vitest setup.",
      "add tests for the signup form",
      "Write an end-to-end test that signs up, creates a project, invites a teammate and checks the invite email arrives, using Playwright.",
      "we have zero test coverage on utils/date.ts, add some",
    ],
    ko: [
      "pricing/discount.ts 할인 계산기에 대한 단위 테스트를 작성해 주세요. 중복 할인, 100% 상한, 만료된 코드, 센트 단위 반올림을 다루고 기존 vitest 설정을 써 주세요.",
      "회원가입 폼 테스트 추가해줘",
      "가입하고, 프로젝트 만들고, 팀원 초대하고, 초대 메일이 오는지까지 확인하는 E2E 테스트를 Playwright로 작성해 주세요.",
      "utils/date.ts 테스트 커버리지가 0이야, 테스트 좀 써줘",
    ],
  },
  spec: {
    en: [
      "Write a product spec for shared dashboards: the problem, who it's for, scope and non-goals, the permissions model, and how we'll measure success. Two pages at most.",
      "draft a project plan for the billing migration",
      "Turn these meeting notes into a one-page PRD for the mobile offline mode, with open questions at the end.",
      "write requirements for the new onboarding flow",
    ],
    ko: [
      "공유 대시보드 기능의 제품 기획서를 써 주세요. 문제, 대상 사용자, 범위와 제외 범위, 권한 모델, 성공 지표까지 두 페이지 이내로요.",
      "결제 시스템 이전 프로젝트 계획 짜줘",
      "이 회의록을 모바일 오프라인 모드에 대한 한 페이지짜리 PRD로 정리하고 마지막에 미결 사항을 적어 주세요.",
      "새 온보딩 플로우 요구사항 정리해줘",
    ],
  },
  design: {
    en: [
      "Mock up the settings page for team billing: plan card, seat count with +/- controls, invoice list. Use our existing component styles and show the empty state too.",
      "design a banner for the spring sale",
      "Lay out three options for the new onboarding screen on mobile, 390px wide, and note which one you'd pick and why.",
      "make a wireframe for the admin dashboard",
    ],
    ko: [
      "팀 결제 설정 페이지 목업을 만들어 주세요. 요금제 카드, +/- 버튼이 있는 좌석 수, 청구서 목록이 들어가고 기존 컴포넌트 스타일을 쓰고 빈 상태 화면도 보여 주세요.",
      "봄 세일 배너 디자인해줘",
      "390px 너비 모바일 온보딩 화면 시안을 세 가지 잡아 주시고, 어떤 걸 고를지와 이유도 적어 주세요.",
      "관리자 대시보드 와이어프레임 그려줘",
    ],
  },
  copy: {
    en: [
      "Write a 900-word blog post announcing our Korean-language support, aimed at ops managers. Warm, concrete, one customer quote placeholder, and a call to action to book a demo.",
      "write landing page copy for the new API product",
      "Three LinkedIn posts for the product launch next week: one story, one stat, one question. Under 80 words each.",
      "need a tagline for the pricing page hero",
    ],
    ko: [
      "한국어 지원 출시를 알리는 운영 매니저 대상 블로그 글을 2,000자 정도로 써 주세요. 따뜻하고 구체적으로, 고객 인용 자리 하나, 데모 예약 유도 문구로 마무리해 주세요.",
      "새 API 상품 랜딩페이지 문구 써줘",
      "다음 주 출시용 링크드인 게시물 세 개를 써 주세요. 하나는 사례, 하나는 수치, 하나는 질문으로, 각각 150자 이내로요.",
      "요금제 페이지 상단 카피 한 줄 뽑아줘",
    ],
  },
  translate: {
    en: [
      "Translate this help article on setting up SSO into Korean. Keep product names and menu labels in English, use the formal polite register, and keep the headings.",
      "put this customer reply into English",
      "Translate my answer to the Korean customer below; it should sound natural to them, not word-for-word.",
      "translate the release notes to Korean",
    ],
    ko: [
      "SSO 설정 도움말 문서를 영어로 번역해 주세요. 제목 구조는 그대로 두고, 제품명과 메뉴 이름은 원문 그대로, 자연스러운 미국식 영어로요.",
      "이 고객 답장 영어로 옮겨줘",
      "아래 영어권 고객에게 보낼 제 답변을 번역해 주세요. 직역 말고 자연스럽게요.",
      "릴리스 노트 한국어로 번역해줘",
    ],
  },
  policy: {
    en: [
      "Review this MSA from Ridgeway before legal sees it. Flag anything on liability caps, auto-renewal and data processing that differs from our standard terms, with the clause numbers.",
      "draft a remote work policy",
      "Write our acceptable use policy for AI tools: what employees may paste in, what needs approval, and what's banned. Plain language, one page.",
      "check this NDA for anything unusual",
    ],
    ko: [
      "법무팀에 넘기기 전에 리지웨이 기본계약서를 검토해 주세요. 책임 한도, 자동 갱신, 데이터 처리 조항 중 우리 표준과 다른 부분을 조항 번호와 함께 표시해 주세요.",
      "재택근무 규정 초안 써줘",
      "AI 도구 사용 정책을 써 주세요. 직원이 입력해도 되는 것, 승인이 필요한 것, 금지된 것을 쉬운 말로 한 페이지에 정리해 주세요.",
      "이 NDA에 이상한 조항 있는지 봐줘",
    ],
  },
  hr: {
    en: [
      "Write a job description for a senior backend engineer: Go and Postgres, on-call one week in six, hybrid in Seoul. Include the salary band placeholder and skip the clichés.",
      "summarize these peer reviews for Dana's mid-year check-in",
      "Put together a 30-60-90 day onboarding plan for a new customer success manager, with who they should meet in week one.",
      "write a JD for a product designer",
    ],
    ko: [
      "시니어 백엔드 엔지니어 채용공고를 써 주세요. Go와 Postgres, 6주에 1주 온콜, 서울 하이브리드 근무이고 연봉 범위 자리 표시와 진부한 표현은 빼 주세요.",
      "다나 상반기 면담용으로 동료 평가 내용 정리해줘",
      "신규 고객성공 매니저를 위한 30-60-90일 온보딩 계획을 짜 주시고 첫 주에 만나야 할 사람도 적어 주세요.",
      "프로덕트 디자이너 채용공고 써줘",
    ],
  },
  finance: {
    en: [
      "Reconcile September's card transactions against the ledger export. List every mismatch over $10 with the date and amount, and total what's unexplained.",
      "check these vendor invoices against the POs",
      "Match the Stripe payouts to bank deposits for last month and tell me which payouts are missing or short.",
      "find duplicate invoices in this list",
    ],
    ko: [
      "9월 법인카드 거래 내역을 장부 내보내기와 대사해 주세요. 1만 원 넘는 불일치 건을 날짜와 금액과 함께 나열하고 설명 안 되는 금액 합계도 알려 주세요.",
      "이 거래처 세금계산서들 발주서랑 맞는지 확인해줘",
      "지난달 스트라이프 정산액을 통장 입금 내역과 맞춰 보고 빠지거나 모자란 정산 건을 알려 주세요.",
      "이 목록에서 중복 청구서 찾아줘",
    ],
  },
};

/** Not about work, too vague to place, or asking to learn: a correct classifier names no kind. */
const NONE: Rows = {
  en: [
    "what's a good place for lunch near Gangnam station",
    "hey",
    "can you help me with something",
    "write me a poem about my cat",
    "do the thing from earlier",
    "What's the difference between a PR review and a code audit?",
    "Explain what an accrual is like I'm new to accounting",
    "I drafted this email to a customer, does it sound too pushy?",
  ],
  ko: [
    "강남역 근처 점심 맛집 추천해줘",
    "하이 반가워",
    "뭐 좀 도와줄 수 있어?",
    "우리 고양이에 대한 시 써줘",
    "아까 그거 해줘",
    "PR 리뷰랑 코드 감사는 뭐가 달라요?",
    "회계 처음인 사람한테 설명하듯이 발생주의가 뭔지 알려줘",
    "고객한테 보낼 메일 초안인데 너무 밀어붙이는 느낌인가요?",
  ],
};

export const TUNING_EXAMPLES: TrainingExample[] = [
  ...Object.entries(BY_ACTION).flatMap(([action, rows]) =>
    (["en", "ko"] as const).flatMap((lang) => rows[lang].map((text) => ({ action, learn: false, lang, text }))),
  ),
  ...(["en", "ko"] as const).flatMap((lang) => NONE[lang].map((text) => ({ action: null, learn: false, lang, text }))),
];

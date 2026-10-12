/*
 * Contrastive training examples: kinds of work that share words with a neighbour. "Review" a contract
 * (policy) or a pull request (review); a test that fails (fix) or tests to write (test); a summary of
 * what happened (summ) or copy for an audience (copy). Each example leans on the word the neighbour
 * also uses, so the head learns what tells them apart. The pairs come from the tuning slice
 * (tuning.ts), never from the evaluation set.
 */
import type { TrainingRows } from "./types.js";

export const CONTRAST: TrainingRows = {
  fix: {
    en: [
      "The integration test for refunds keeps failing on CI, find out what broke in the code",
      "test_invoice_totals fails since yesterday's merge, track down the bug and fix it",
      "Our e2e suite is red because login redirects to a blank page. Fix the redirect.",
      "A unit test caught a rounding error in tax calculation, patch the calculation",
      "flaky test turned out to be a real race condition in the cache, fix the race",
      "The tests pass locally but the build fails in production, figure out why and fix it",
      "Error rate on the payments API spiked after the release. Find the cause and roll forward a fix.",
      "Customers get logged out every 5 minutes, debug the session expiry",
    ],
    ko: [
      "CI에서 환불 통합 테스트가 계속 실패해, 코드에서 뭐가 깨졌는지 찾아줘",
      "어제 머지 이후로 test_invoice_totals가 실패해요. 버그 찾아서 고쳐 주세요.",
      "로그인하면 빈 페이지로 리다이렉트돼서 E2E가 다 빨간불이야, 리다이렉트 고쳐줘",
      "단위 테스트에서 세금 계산 반올림 오류가 잡혔어요. 계산 로직을 수정해 주세요.",
      "불안정한 테스트인 줄 알았는데 캐시 경쟁 조건이었어, 그거 고쳐줘",
      "로컬에선 테스트가 통과하는데 운영 빌드가 실패해요. 원인 찾아서 고쳐 주세요.",
      "배포 이후 결제 API 에러율이 튀었어요. 원인을 찾아서 수정해 주세요.",
      "고객들이 5분마다 로그아웃돼, 세션 만료 디버깅해줘",
    ],
  },
  test: {
    en: [
      "Nothing tests the refund flow yet. Write integration tests for full and partial refunds.",
      "Add a regression test so the tax rounding bug we fixed can't come back",
      "write Playwright tests for the checkout page, happy path and declined card",
      "Increase coverage on the auth module to 80%, test the token refresh edge cases",
      "Write property-based tests for the date parser",
      "add unit tests for every branch in the permissions helper",
    ],
    ko: [
      "환불 흐름은 아직 테스트가 없어요. 전액 환불과 부분 환불 통합 테스트를 작성해 주세요.",
      "우리가 고친 세금 반올림 버그가 다시 안 생기게 회귀 테스트 추가해줘",
      "결제 페이지 Playwright 테스트 써줘, 정상 결제랑 카드 거절 케이스로",
      "인증 모듈 커버리지를 80%까지 올려 주세요. 토큰 갱신 경계 케이스를 테스트해 주세요.",
      "날짜 파서에 속성 기반 테스트 작성해줘",
      "권한 헬퍼의 모든 분기에 단위 테스트 추가해줘",
    ],
  },
  policy: {
    en: [
      "Review the vendor agreement and mark any clause that lets them use our data for training",
      "Look over this SaaS contract and tell me what the termination terms really say",
      "check the indemnity section of this partnership agreement against our playbook",
      "Go through the DPA they sent and list where it deviates from GDPR standard clauses",
      "review this lease for anything that puts the cost of repairs on us",
      "Redline the liability cap in this order form",
      "Draft our data retention policy: what we keep, for how long, and who can delete it",
      "write a travel and expense policy for a 40-person company",
    ],
    ko: [
      "공급업체 계약서 검토해서 우리 데이터를 학습에 쓸 수 있게 한 조항 표시해줘",
      "이 SaaS 계약서 해지 조항이 실제로 무슨 뜻인지 검토해 주세요",
      "제휴 계약서 면책 조항을 우리 기준이랑 비교해서 봐줘",
      "상대방이 보낸 데이터처리약정서를 검토해서 GDPR 표준 조항과 다른 곳을 정리해 주세요.",
      "이 임대차 계약서에 수리비를 우리가 부담하게 하는 내용 있는지 검토해줘",
      "이 주문서의 책임 한도 조항에 수정 의견 달아줘",
      "데이터 보관 정책 초안을 써 주세요. 무엇을, 얼마나, 누가 삭제할 수 있는지요.",
      "40명 규모 회사 출장비 경비 규정 써줘",
    ],
  },
  review: {
    en: [
      "Review the pull request that adds the webhook retry logic, and flag anything that could loop forever",
      "look over this PR's database queries for N+1 problems",
      "Give feedback on my teammate's refactor of the auth middleware before we merge",
      "review the diff in this merge request and approve it or list what blocks it",
      "Check this pull request for missing error handling",
      "code review please, mostly worried about the concurrency in worker.go",
    ],
    ko: [
      "웹훅 재시도 로직을 추가한 풀리퀘스트를 리뷰하고 무한 반복될 수 있는 부분을 짚어 주세요",
      "이 PR 데이터베이스 쿼리에 N+1 문제 있는지 봐줘",
      "머지 전에 동료가 인증 미들웨어 리팩터링한 거 코드 리뷰해 주세요",
      "이 머지 리퀘스트 diff 리뷰하고 승인할지 막는 이유가 뭔지 알려줘",
      "이 풀리퀘스트에 빠진 에러 처리 있는지 확인해줘",
      "코드 리뷰 부탁해, worker.go 동시성 부분이 제일 걱정돼",
    ],
  },
  summ: {
    en: [
      "Summarise this Slack thread about the outage so someone who missed it can catch up",
      "condense the meeting transcript into decisions and action items",
      "Give me the gist of the last two weeks of emails with Orbit Labs",
      "Recap the customer interview recordings: what they liked, what confused them",
      "boil this 30-page report down to half a page",
      "write a summary of the incident channel for the postmortem doc",
    ],
    ko: [
      "장애 관련 슬랙 스레드를 못 본 사람도 따라올 수 있게 요약해 주세요",
      "회의 녹취록을 결정 사항이랑 할 일로 정리해줘",
      "오르빗랩스랑 최근 2주 주고받은 메일 핵심만 알려줘",
      "고객 인터뷰 녹음 내용을 좋았던 점, 헷갈려한 점으로 정리해 주세요",
      "이 30페이지 보고서를 반 페이지로 줄여줘",
      "회고 문서에 넣을 수 있게 장애 채널 내용 요약해줘",
    ],
  },
  copy: {
    en: [
      "Write the announcement post for our new pricing, upbeat but honest about the increase",
      "punchy headline and subhead for the integrations page",
      "Write a newsletter intro for customers about the spring release",
      "write ad copy for a search campaign aimed at finance teams, three variants",
      "Product Hunt launch description, 260 characters",
      "Draft the copy for our careers page hero section",
    ],
    ko: [
      "새 요금제 공지 글을 써 주세요. 밝지만 인상 사실은 솔직하게요.",
      "연동 페이지 헤드라인이랑 서브카피 임팩트 있게 뽑아줘",
      "봄 업데이트 소식 전하는 고객 뉴스레터 도입부 써줘",
      "재무팀 대상 검색 광고 문구 세 가지 버전으로 써줘",
      "프로덕트헌트 출시 소개 문구 260자로 써줘",
      "채용 페이지 상단 카피 초안 써 주세요",
    ],
  },
  research: {
    en: [
      "Find out what payroll tools mid-size Korean companies use most, with sources",
      "research how other SaaS companies handle usage-based pricing for AI features",
      "Dig up recent funding news and leadership changes at Corvid Analytics",
      "what are the main regulations on storing health data in Korea? find sources",
      "Gather public reviews of our competitor's onboarding and list the common complaints",
      "look into who the key buyers are for logistics software in Southeast Asia",
    ],
    ko: [
      "국내 중견기업이 가장 많이 쓰는 급여 관리 도구가 뭔지 출처와 함께 찾아줘",
      "다른 SaaS 회사들이 AI 기능 사용량 기반 요금을 어떻게 받는지 조사해 주세요",
      "코르비드애널리틱스 최근 투자 소식이랑 경영진 변동 찾아줘",
      "국내에서 건강 데이터 저장 관련 주요 규제가 뭔지 출처랑 같이 알아봐줘",
      "경쟁사 온보딩에 대한 공개 리뷰를 모아서 자주 나오는 불만을 정리해 주세요",
      "동남아 물류 소프트웨어 주요 구매자가 누군지 알아봐줘",
    ],
  },
  spec: {
    en: [
      "Write the scope doc for audit logs: user stories, what's in v1, what's out, rollout plan",
      "plan the migration to the new billing provider: phases, owners, risks, dates",
      "Draft a technical design for moving file storage to S3, with alternatives considered",
      "Write acceptance criteria for the bulk edit feature",
      "put together a launch plan for the Korean market with milestones",
      "one-pager proposing a self-serve trial, problem, solution, metrics",
    ],
    ko: [
      "감사 로그 기능 범위 문서 써줘. 사용자 스토리, v1 포함/제외, 출시 계획까지",
      "새 결제 대행사로 이전하는 계획을 단계, 담당자, 리스크, 일정으로 짜 주세요",
      "파일 저장소를 S3로 옮기는 기술 설계 문서 초안을 검토한 대안과 함께 써 주세요",
      "일괄 수정 기능 인수 조건 작성해줘",
      "한국 시장 출시 계획을 마일스톤과 함께 정리해줘",
      "셀프 체험판 도입을 제안하는 한 장짜리 문서, 문제·해결책·지표로 써줘",
    ],
  },
  design: {
    en: [
      "Sketch the empty state for the inbox when there are no messages yet",
      "design the pricing table layout with three tiers and a toggle for annual billing",
      "Create a social card image for the launch, 1200x630, with our logo and the headline",
      "Mock up a mobile version of the invoice detail screen",
      "redesign the signup form so it fits on one screen",
      "make a few visual concepts for the conference booth backdrop",
    ],
    ko: [
      "메시지가 아직 없을 때 받은편지함 빈 화면 시안 그려줘",
      "연간 결제 토글이 있는 3단계 요금표 레이아웃 디자인해줘",
      "출시용 소셜 카드 이미지를 1200x630으로 로고와 헤드라인 넣어서 만들어 주세요",
      "청구서 상세 화면 모바일 버전 목업 만들어줘",
      "가입 폼이 한 화면에 들어가게 다시 디자인해줘",
      "컨퍼런스 부스 배경 비주얼 콘셉트 몇 가지 잡아줘",
    ],
  },
  hr: {
    en: [
      "Write a job posting for a part-time bookkeeper, remote, 20 hours a week",
      "summarize the 360 feedback for my direct report into strengths and growth areas",
      "Create a first-week onboarding checklist for new engineers",
      "draft interview questions for a customer success role, with what a good answer looks like",
      "Write the promotion case for Mina based on her last two quarters",
      "outline a performance improvement plan for a sales rep missing quota",
    ],
    ko: [
      "주 20시간 원격 근무 파트타임 경리 채용공고 써줘",
      "팀원 다면평가 내용을 강점이랑 성장 포인트로 정리해 주세요",
      "신입 엔지니어 첫 주 온보딩 체크리스트 만들어줘",
      "고객성공 직무 면접 질문이랑 좋은 답변 기준 같이 써줘",
      "지난 두 분기 성과를 바탕으로 미나 승진 추천서 써 주세요",
      "목표 미달인 영업 담당자 성과 개선 계획 초안 잡아줘",
    ],
  },
  email: {
    en: [
      "Email the Acme buyer to say the renewal quote is attached and ask if they need anything for procurement",
      "write a thank-you email after the onsite at Pinecrest, recap the next steps",
      "Send a check-in email to a customer who went quiet after the trial",
      "outreach email to a VP of finance we met at the conference",
      "Write the email introducing our new account manager to the customer",
      "follow up with the prospect who asked for the security questionnaire",
    ],
    ko: [
      "아크미 구매 담당자한테 갱신 견적서 첨부했다고, 구매 절차에 필요한 거 있는지 묻는 메일 써줘",
      "파인크레스트 방문 미팅 후 감사 메일을 다음 단계 정리와 함께 써 주세요",
      "체험판 이후 연락이 끊긴 고객에게 안부 메일 보내줘",
      "컨퍼런스에서 만난 재무 담당 부사장한테 보낼 아웃리치 메일 써줘",
      "새 어카운트 매니저를 고객에게 소개하는 메일 써 주세요",
      "보안 설문지 요청했던 잠재고객한테 팔로업 메일 써줘",
    ],
  },
};

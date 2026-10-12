/*
 * The phrases the work classifier compares a first message with: a few per kind of work, in English
 * and Korean, plus phrases for asking to learn and for things that are not work.
 *
 * These are part of the classifier, not of its evaluation. They are written apart from the
 * evaluation set (eval/work-samples.ts) and never copied from it, so a score on that set measures how
 * the classifier does on messages it has not seen. `prototypes.test.ts` fails if any phrase
 * here also appears there.
 */

export type Prototype = { action: string | null; learn: boolean; text: string };

const work = (action: string, phrases: readonly string[]): Prototype[] =>
  phrases.map((text) => ({ action, learn: false, text }));

export const WORK_PROTOTYPES: Prototype[] = [
  ...work("reply", [
    "answer a customer's support ticket",
    "write a reply to the customer who reported a problem",
    "respond to this help desk request",
    "고객 문의 티켓에 답변 작성",
    "문제를 신고한 고객에게 보낼 답장",
    "고객센터 문의에 회신",
  ]),
  ...work("summ", [
    "summarize this conversation for me",
    "give me the key points of the meeting transcript",
    "condense the thread into a short recap",
    "이 대화 내용 요약",
    "회의 녹취록 핵심 정리",
    "스레드를 짧게 정리해줘",
  ]),
  ...work("email", [
    "write an email to a client",
    "draft an outreach email to a prospect",
    "compose a follow-up message to the customer",
    "고객사에 보낼 이메일 작성",
    "잠재 고객에게 보낼 영업 메일",
    "고객에게 후속 메일 쓰기",
  ]),
  ...work("research", [
    "look up information about this company",
    "investigate the market and competitors",
    "find sources and background on an account",
    "이 회사에 대한 정보 조사",
    "시장과 경쟁사 리서치",
    "고객사 배경 자료 찾기",
  ]),
  ...work("analyze", [
    "analyze the data in this spreadsheet",
    "find trends in these numbers",
    "compare figures across the sheet and report what changed",
    "이 스프레드시트 데이터 분석",
    "숫자에서 추세 찾기",
    "시트 수치 비교해서 변화 보고",
  ]),
  ...work("code", [
    "implement a new feature in the codebase",
    "add an API endpoint",
    "build a component for the app",
    "코드베이스에 새 기능 구현",
    "API 엔드포인트 추가",
    "앱에 들어갈 컴포넌트 개발",
  ]),
  ...work("fix", [
    "fix this bug",
    "debug why the service is failing",
    "the build is broken, find the cause and repair it",
    "이 버그 수정",
    "서비스가 실패하는 원인 디버깅",
    "빌드 깨진 거 원인 찾아서 고치기",
  ]),
  ...work("review", [
    "review this pull request",
    "look over the code changes and point out problems",
    "do a code review of the diff",
    "이 풀 리퀘스트 리뷰",
    "코드 변경사항 검토하고 문제 지적",
    "diff 코드 리뷰",
  ]),
  ...work("test", [
    "write tests for this module",
    "add test cases that cover the edge cases",
    "create an automated test for the flow",
    "이 모듈 테스트 작성",
    "엣지 케이스 테스트 추가",
    "흐름 자동화 테스트 만들기",
  ]),
  ...work("spec", [
    "write a product requirements document",
    "plan the project with milestones",
    "draft a spec for the feature",
    "제품 요구사항 문서 작성",
    "마일스톤으로 프로젝트 계획",
    "기능 기획서 초안",
  ]),
  ...work("design", [
    "design a screen layout",
    "create a mockup of the page",
    "make a visual for the campaign",
    "화면 레이아웃 디자인",
    "페이지 시안 만들기",
    "캠페인 비주얼 제작",
  ]),
  ...work("copy", [
    "write marketing copy",
    "draft a blog article for our audience",
    "write a social media post announcing the launch",
    "마케팅 문구 작성",
    "블로그 글 초안",
    "출시 알리는 SNS 게시물",
  ]),
  ...work("translate", [
    "translate this text into another language",
    "localize the document for Korean readers",
    "translate the customer's message to English",
    "이 글을 다른 언어로 번역",
    "문서를 영어 독자용으로 현지화",
    "고객 메시지 한국어로 번역",
  ]),
  ...work("policy", [
    "review the terms of this contract",
    "check the agreement for legal risks",
    "draft a company policy",
    "계약서 조항 검토",
    "계약의 법적 리스크 확인",
    "회사 정책 초안 작성",
  ]),
  ...work("hr", [
    "write a job posting",
    "summarize performance feedback for an employee",
    "create an onboarding plan for a new hire",
    "채용 공고 작성",
    "직원 성과 피드백 요약",
    "신입 사원 온보딩 계획",
  ]),
  ...work("finance", [
    "reconcile the accounts",
    "check invoices against purchase orders",
    "match bank transactions to the ledger",
    "계정 대사 작업",
    "송장과 발주서 대조",
    "은행 거래와 장부 맞추기",
  ]),
  /* Asking to learn: an explanation, or a review of one's own work, rather than the work. */
  ...[
    "explain how this works",
    "help me understand the concept",
    "what am I doing wrong here, give me feedback",
    "is my draft good enough",
    "이게 어떻게 동작하는지 설명해줘",
    "개념을 이해하게 도와줘",
    "내가 뭘 잘못하고 있는지 피드백 해줘",
    "내 초안 괜찮은지 봐줘",
  ].map((text) => ({ action: null, learn: true, text })),
  /* Not about work: personal asks and messages with nothing to classify. */
  ...[
    "plan my vacation",
    "suggest something to cook tonight",
    "tell me a joke",
    "ok thanks",
    "go on",
    "휴가 계획 세워줘",
    "오늘 저녁 뭐 먹지",
    "농담 하나 해줘",
    "응 고마워",
    "계속",
  ].map((text) => ({ action: null, learn: false, text })),
];

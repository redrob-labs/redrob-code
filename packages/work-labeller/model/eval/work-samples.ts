/*
 * The work classifier evaluation set: first instructions a person might give Redrob Cowork, in English
 * and Korean, each tagged by hand with what a correct classifier should answer.
 *
 * Every sample is written here, so no candidate model can have trained on it. Names, companies and
 * figures are invented.
 *
 * The labels are the ones Crew and the Redrob Console use (console `insights/reference.ts`):
 *   - action: one of the 16 kinds of work, or null when the instruction is not about work or is too
 *     vague to place. A classifier that answers "not labeled" there is right.
 *   - task: the task under that action (the console's `action.task-slug` without the action), or
 *     null when the work fits the action but none of its tasks.
 *   - brief: the instruction says what done looks like: who it is for, the form, the length or the
 *     test that proves it. Saying only what to work on is not a brief.
 *   - learn: the person asks for an explanation, or a review of their own work, rather than for the
 *     work itself (mode 1, Learn).
 *
 * Sample tuple: [task, brief, learn, text]. `review.md` beside this file says how to review it.
 */

export type WorkSample = {
  id: string;
  lang: "en" | "ko" | "mixed";
  /** Hard cases are reported apart: a set of only easy ones flatters every model. */
  source: "plain" | "hard";
  text: string;
  action: string | null;
  task: string | null;
  brief: boolean;
  learn: boolean;
};

type Row = readonly [task: string | null, brief: 0 | 1, learn: 0 | 1, text: string];
type ActionRows = { en: readonly Row[]; ko: readonly Row[] };

const PLAIN: Record<string, ActionRows> = {
  reply: {
    en: [
      ["refund-request", 1, 0, "Customer says they were charged twice for the annual plan and wants one charge back. Draft a reply under 120 words, apologetic but not grovelling, that confirms the refund goes out in 5-7 business days."],
      ["refund-request", 0, 0, "Help me answer this refund request, ticket pasted below."],
      ["bug-report-reply", 1, 0, "A user reports the export button does nothing in Safari. Write a reply that thanks them, says engineering reproduced it, gives the workaround (use Chrome or the CSV link in Settings) and promises an update by Friday. Keep it to two short paragraphs."],
      ["bug-report-reply", 0, 0, "Reply to this bug report from a customer about the login loop"],
      ["how-to-answer", 1, 0, "Customer asks how to add a teammate as a viewer. Answer in numbered steps, max 5, and link to the Members help page at the end."],
      ["how-to-answer", 0, 0, "can you answer this question about setting up SSO for them"],
      ["escalation-response", 1, 0, "This enterprise customer is angry that the outage broke their payroll run. Draft a response from me as head of support: own the problem, give the timeline from the incident report attached, offer a call today, no discounts promised. Under 200 words."],
      ["escalation-response", 0, 1, "Here's the reply I wrote to an escalated ticket. Is the tone okay or does it sound defensive?"],
    ],
    ko: [
      ["refund-request", 1, 0, "고객이 연간 요금제가 두 번 결제됐다고 환불을 요청했어요. 사과하면서도 과하지 않게, 영업일 기준 5~7일 안에 환불된다고 안내하는 답장을 150자 이내로 써 주세요."],
      ["refund-request", 0, 0, "이 환불 문의 답변 좀 도와줘"],
      ["bug-report-reply", 1, 0, "사파리에서 내보내기 버튼이 안 눌린다는 버그 신고가 들어왔어요. 재현했다는 것, 임시 해결책(크롬 사용 또는 설정의 CSV 링크), 금요일까지 업데이트 드린다는 내용으로 두 문단짜리 답장을 써 주세요."],
      ["bug-report-reply", 0, 0, "로그인이 계속 반복된다는 고객 버그 신고에 답장 써줘"],
      ["how-to-answer", 1, 0, "팀원을 뷰어 권한으로 추가하는 방법을 묻는 고객 문의예요. 5단계 이내 번호 목록으로 답하고 마지막에 멤버 도움말 링크를 넣어 주세요."],
      ["how-to-answer", 0, 0, "SSO 설정 방법 물어본 고객한테 답변해줘"],
      ["escalation-response", 1, 0, "장애 때문에 급여 처리가 멈췄다고 화가 난 엔터프라이즈 고객입니다. 고객지원 총괄인 제 이름으로, 책임을 인정하고 첨부한 장애 보고서의 타임라인을 설명하고 오늘 통화를 제안하는 답장을 써 주세요. 할인 약속은 하지 말고 300자 이내로."],
      ["escalation-response", 0, 1, "에스컬레이션된 티켓에 이렇게 답장을 썼는데, 너무 방어적으로 들리나요?"],
    ],
  },
  summ: {
    en: [
      ["ticket-thread-summary", 1, 0, "Summarize this 40-message ticket thread for the engineer picking it up: what the customer reported, what we already tried, and what is still open. Bullet points, no more than 8."],
      ["ticket-thread-summary", 0, 0, "Summarize this ticket thread"],
      ["call-notes", 1, 0, "Turn this call transcript into notes for the account team: decisions, action items with owners, and risks. Use three headed sections and keep it to one screen."],
      ["call-notes", 0, 0, "write up notes from the call with Northwind this morning, transcript attached"],
      ["weekly-account-digest", 1, 0, "From the activity export attached, write the weekly digest for our top 10 accounts: one line each on usage change, open tickets and renewal date, sorted by renewal."],
      ["weekly-account-digest", 0, 0, "Can you do the weekly account digest again?"],
      [null, 0, 0, "tl;dr this thread for me"],
      ["call-notes", 0, 1, "These are my notes from the customer call. Did I miss anything important from the transcript?"],
    ],
    ko: [
      ["ticket-thread-summary", 1, 0, "이 티켓을 이어받을 개발자를 위해 40개 메시지 스레드를 요약해 주세요. 고객이 보고한 내용, 이미 시도한 것, 아직 남은 문제를 8개 이내 글머리표로."],
      ["ticket-thread-summary", 0, 0, "이 티켓 스레드 요약해줘"],
      ["call-notes", 1, 0, "통화 녹취록을 영업팀용 회의록으로 정리해 주세요. 결정 사항, 담당자가 있는 액션 아이템, 리스크 세 부분으로 나누고 한 화면 분량으로."],
      ["call-notes", 0, 0, "오늘 오전 노스윈드랑 한 통화 내용 정리해줘. 녹취록 첨부했어"],
      ["weekly-account-digest", 1, 0, "첨부한 활동 내역으로 상위 10개 고객사 주간 다이제스트를 만들어 주세요. 고객사마다 사용량 변화, 열린 티켓, 갱신일을 한 줄씩, 갱신일 순으로."],
      ["weekly-account-digest", 0, 0, "이번 주 고객사 다이제스트도 부탁해"],
      [null, 0, 0, "이 스레드 세 줄 요약"],
      ["call-notes", 0, 1, "고객 통화 메모를 이렇게 정리했는데 녹취록에서 빠뜨린 중요한 내용이 있을까요?"],
    ],
  },
  email: {
    en: [
      ["renewal-note", 1, 0, "Write a renewal reminder to Harborline's ops lead: their contract ends Nov 30, usage grew 40% this year, and we can hold this year's price if they sign by Nov 15. Friendly, under 150 words, one clear ask."],
      ["renewal-note", 0, 0, "draft the renewal email for Stonebridge"],
      ["cold-first-touch", 1, 0, "Cold email to a VP of Finance at a 300-person logistics company. Hook on month-end close taking too long, one line of proof (a customer cut close from 9 days to 4), ask for 20 minutes. Max 90 words, no buzzwords."],
      ["cold-first-touch", 0, 0, "Write a cold outreach email to this prospect"],
      ["demo-follow-up", 1, 0, "Follow-up after today's demo with Meridian. Recap the three things they cared about (approvals, audit log, SSO), attach the security pack, and propose two times next week for a technical call. Under 180 words."],
      ["demo-follow-up", 0, 0, "send a follow up to the people from the demo yesterday"],
      [null, 0, 0, "Email the customer that their account manager is changing"],
      ["cold-first-touch", 0, 1, "Why do my cold emails get so few replies? Here are three I sent last week."],
    ],
    ko: [
      ["renewal-note", 1, 0, "하버라인 운영 책임자에게 보낼 갱신 안내 메일을 써 주세요. 계약은 11월 30일 종료, 올해 사용량 40% 증가, 11월 15일까지 서명하면 올해 가격 유지. 친근하게, 300자 이내, 요청은 하나만."],
      ["renewal-note", 0, 0, "스톤브리지 갱신 메일 초안 써줘"],
      ["cold-first-touch", 1, 0, "300명 규모 물류회사 재무 담당 임원에게 보낼 첫 콜드메일입니다. 월말 결산이 오래 걸린다는 점으로 시작하고, 고객사 사례 한 줄(결산 9일→4일), 20분 미팅 요청. 200자 이내, 유행어 없이."],
      ["cold-first-touch", 0, 0, "이 잠재 고객한테 보낼 첫 영업 메일 써줘"],
      ["demo-follow-up", 1, 0, "오늘 메리디안 데모 후속 메일이에요. 관심 보였던 세 가지(승인, 감사 로그, SSO)를 정리하고 보안 자료를 첨부하고, 다음 주 기술 미팅 시간 두 개를 제안해 주세요. 400자 이내."],
      ["demo-follow-up", 0, 0, "어제 데모 참석자들한테 후속 메일 보내줘"],
      [null, 0, 0, "고객한테 담당 매니저가 바뀐다고 메일 써줘"],
      ["cold-first-touch", 0, 1, "제 콜드메일 답장률이 왜 이렇게 낮을까요? 지난주에 보낸 세 통이에요."],
    ],
  },
  research: {
    en: [
      ["account-brief", 1, 0, "Before my call with Ironwood Robotics on Thursday, put together a one-page brief: what they sell, headcount, recent funding or news from the last 6 months, and who we know there from the CRM export attached. Cite a source for each fact."],
      ["account-brief", 0, 0, "Research Silverleaf for me before the meeting"],
      ["competitor-scan", 1, 0, "Compare the three main competitors in the attached list on pricing, SSO support and audit logs. A table with one row per competitor, and a source link per cell."],
      ["competitor-scan", 0, 0, "what are our competitors doing with AI features"],
      [null, 1, 0, "Find the market size for B2B invoice automation in Korea and Japan, with sources from 2025 or later, as a short table."],
      ["account-brief", 0, 0, "who is Oakridge Partners and what do they do"],
      ["competitor-scan", 0, 0, "Look into how competitors price their enterprise tier"],
      ["account-brief", 0, 1, "I wrote this account brief on Crescent. Is anything in it out of date?"],
    ],
    ko: [
      ["account-brief", 1, 0, "목요일 아이언우드 로보틱스 미팅 전에 한 장짜리 브리프를 만들어 주세요. 주요 제품, 직원 수, 최근 6개월 투자나 뉴스, 첨부한 CRM 내보내기에서 우리와 아는 사람. 사실마다 출처를 달아 주세요."],
      ["account-brief", 0, 0, "미팅 전에 실버리프 좀 조사해줘"],
      ["competitor-scan", 1, 0, "첨부 목록의 주요 경쟁사 세 곳을 가격, SSO 지원, 감사 로그 기준으로 비교해 주세요. 경쟁사마다 한 행, 칸마다 출처 링크가 있는 표로."],
      ["competitor-scan", 0, 0, "경쟁사들 AI 기능 뭐 하고 있는지 알아봐줘"],
      [null, 1, 0, "한국과 일본의 B2B 송장 자동화 시장 규모를 2025년 이후 자료로 찾아서 짧은 표로 정리해 주세요."],
      ["account-brief", 0, 0, "오크리지 파트너스가 뭐 하는 회사야?"],
      ["competitor-scan", 0, 0, "경쟁사들이 엔터프라이즈 요금제를 어떻게 책정하는지 조사해줘"],
      ["account-brief", 0, 1, "크레센트 고객사 브리프를 써 봤는데 오래된 정보가 있는지 봐 주세요."],
    ],
  },
  analyze: {
    en: [
      ["pipeline-review", 1, 0, "From the pipeline sheet attached, list deals over $50k that haven't moved stage in 30 days, with owner and next step, sorted by amount. Then one sentence on the total at risk."],
      ["pipeline-review", 0, 0, "look at our pipeline and tell me what's stuck"],
      ["churn-analysis", 1, 0, "Using the attached customer export, compare churned vs retained accounts in the last 12 months on seats, tickets per seat and days since last login. Show the method first, then a table and the two biggest differences."],
      ["churn-analysis", 0, 0, "Why are customers churning? Data attached."],
      ["forecast-check", 1, 0, "Check the Q4 forecast in this sheet against the last three quarters' close rates by stage. Flag any rep whose forecast is more than 20% above what their history supports."],
      ["forecast-check", 0, 0, "does this forecast look right to you"],
      [null, 0, 0, "Make a pivot table of this CSV by region"],
      ["churn-analysis", 0, 1, "Here is my churn analysis. Is grouping by plan the right way to do it, or am I missing something?"],
    ],
    ko: [
      ["pipeline-review", 1, 0, "첨부한 파이프라인 시트에서 30일 넘게 단계 변화가 없는 5천만 원 이상 딜을 담당자, 다음 단계와 함께 금액순으로 정리해 주세요. 마지막에 위험 금액 합계를 한 문장으로."],
      ["pipeline-review", 0, 0, "파이프라인 보고 막혀 있는 거 알려줘"],
      ["churn-analysis", 1, 0, "첨부한 고객 데이터로 최근 12개월 이탈 고객과 유지 고객을 좌석 수, 좌석당 티켓 수, 마지막 로그인 이후 일수로 비교해 주세요. 분석 방법을 먼저 설명하고 표와 가장 큰 차이 두 가지를 보여 주세요."],
      ["churn-analysis", 0, 0, "고객들이 왜 이탈하는지 분석해줘. 데이터 첨부함"],
      ["forecast-check", 1, 0, "이 시트의 4분기 전망을 지난 세 분기의 단계별 성사율과 비교해서, 과거 실적보다 20% 넘게 높게 잡은 담당자를 표시해 주세요."],
      ["forecast-check", 0, 0, "이 전망치 맞는 것 같아?"],
      [null, 0, 0, "이 CSV 지역별로 피벗 테이블 만들어줘"],
      ["churn-analysis", 0, 1, "이탈 분석을 요금제별로 묶어서 했는데 이 방법이 맞나요? 놓친 게 있을까요?"],
    ],
  },
  code: {
    en: [
      ["new-endpoint", 1, 0, "Add GET /v1/teams/:id/members to the API: admin or the team lead only, paginated with limit/offset like /v1/logs, returns id, email and role. Add an integration test that a member of another team gets 403."],
      ["new-endpoint", 0, 0, "add an endpoint for listing team members"],
      ["ui-component", 1, 0, "Build a DateRangePicker component for the usage page: presets for 7, 30 and 90 days plus custom, keyboard accessible, uses the kit's Popover. Done when the usage page uses it and the narrow-viewport test passes."],
      ["ui-component", 0, 0, "Make a dropdown component for picking the team"],
      ["data-migration", 1, 0, "Write a migration that adds a nullable team_id to memberships and backfills it from the old groups table, in batches of 1,000, safe to run while the current code is deployed. Include a rollback note."],
      ["data-migration", 0, 0, "we need to move the old settings JSON into real columns"],
      [null, 0, 0, "refactor this file, it's a mess"],
      ["new-endpoint", 0, 1, "Can you explain how this controller decides which permission to check? I'm new to the codebase."],
    ],
    ko: [
      ["new-endpoint", 1, 0, "API에 GET /v1/teams/:id/members를 추가해 주세요. 관리자나 팀장만 접근, /v1/logs처럼 limit/offset 페이지네이션, id·이메일·역할 반환. 다른 팀 멤버는 403을 받는 통합 테스트도 추가해 주세요."],
      ["new-endpoint", 0, 0, "팀 멤버 목록 엔드포인트 추가해줘"],
      ["ui-component", 1, 0, "사용량 페이지용 DateRangePicker 컴포넌트를 만들어 주세요. 7일·30일·90일 프리셋과 직접 선택, 키보드 접근 가능, 키트의 Popover 사용. 사용량 페이지에 적용되고 좁은 화면 테스트가 통과하면 완료입니다."],
      ["ui-component", 0, 0, "팀 고르는 드롭다운 컴포넌트 만들어줘"],
      ["data-migration", 1, 0, "memberships에 nullable team_id를 추가하고 예전 groups 테이블에서 1,000건씩 백필하는 마이그레이션을 작성해 주세요. 현재 배포된 코드와 함께 돌아도 안전해야 하고, 롤백 방법도 적어 주세요."],
      ["data-migration", 0, 0, "예전 설정 JSON을 진짜 컬럼으로 옮겨야 해"],
      [null, 0, 0, "이 파일 리팩터링 좀 해줘. 엉망이야"],
      ["new-endpoint", 0, 1, "이 컨트롤러가 어떤 권한을 검사할지 어떻게 정하는지 설명해 줄래요? 코드베이스가 처음이라서요."],
    ],
  },
  fix: {
    en: [
      ["failing-test", 1, 0, "billing.test.mjs fails on 'auto top-up stops after a decline' since yesterday's merge. Find the cause and fix the code, not the test. Done when yarn test passes locally."],
      ["failing-test", 0, 0, "CI is red, can you fix it"],
      ["production-incident", 1, 0, "Prod is returning 502 on /v1/chat/completions for about 8% of requests since 14:10 KST. Logs attached. Find the likely cause, propose the smallest safe fix, and write the two-line status update for customers."],
      ["production-incident", 0, 0, "the site is down, help"],
      [null, 1, 0, "The date picker shows yesterday for users in New York. Fix it so dates use the browser's time zone, and add a test with America/New_York."],
      ["failing-test", 0, 0, "this test is flaky, make it stop failing"],
      [null, 0, 0, "there's a bug where the avatar doesn't load"],
      ["production-incident", 0, 1, "Why would memory keep climbing on the worker after deploy? Not asking you to fix it yet, just help me understand."],
    ],
    ko: [
      ["failing-test", 1, 0, "어제 머지 이후로 billing.test.mjs의 '결제 거절 후 자동 충전 중단' 테스트가 실패합니다. 원인을 찾아서 테스트가 아니라 코드를 고쳐 주세요. 로컬에서 yarn test가 통과하면 완료입니다."],
      ["failing-test", 0, 0, "CI 빨간불이야. 고쳐줘"],
      ["production-incident", 1, 0, "14시 10분부터 운영 환경 /v1/chat/completions 요청의 약 8%가 502를 반환합니다. 로그 첨부합니다. 가능성 높은 원인을 찾고, 가장 작고 안전한 수정안과 고객 공지용 두 줄 상태 업데이트를 써 주세요."],
      ["production-incident", 0, 0, "사이트 다운됐어 도와줘"],
      [null, 1, 0, "뉴욕 사용자에게 날짜 선택기가 어제 날짜로 보여요. 브라우저 시간대를 쓰도록 고치고 America/New_York 테스트를 추가해 주세요."],
      ["failing-test", 0, 0, "이 테스트 가끔 실패하는데 안 실패하게 해줘"],
      [null, 0, 0, "프로필 사진이 안 뜨는 버그가 있어"],
      ["production-incident", 0, 1, "배포 후에 워커 메모리가 계속 올라가는 이유가 뭘까요? 아직 고치지 말고 이해만 돕고 싶어요."],
    ],
  },
  review: {
    en: [
      ["pull-request-review", 1, 0, "Review PR #193 for security: can a device report sessions for another user or another app? List each finding with file and line, most serious first. Ignore style."],
      ["pull-request-review", 0, 0, "review this PR"],
      ["pull-request-review", 1, 0, "Look at this diff and tell me whether the migration is safe to run while the old code is still deployed. Yes or no first, then why."],
      ["pull-request-review", 0, 0, "can you look over my changes before I push"],
      ["pull-request-review", 0, 1, "I'm about to approve this PR from a teammate. What should I look for in a change to the payment flow?"],
      [null, 0, 0, "is this code any good"],
      ["pull-request-review", 1, 0, "Review the attached patch only for performance: any N+1 queries or unbounded loops? Bullet list, file:line each."],
      ["pull-request-review", 0, 1, "Here's a PR I wrote. Be honest, what would a senior engineer push back on?"],
    ],
    ko: [
      ["pull-request-review", 1, 0, "PR #193을 보안 관점으로 리뷰해 주세요. 기기가 다른 사용자나 다른 앱의 세션을 보고할 수 있나요? 발견 사항마다 파일과 줄 번호를, 심각한 것부터. 스타일은 무시해 주세요."],
      ["pull-request-review", 0, 0, "이 PR 리뷰해줘"],
      ["pull-request-review", 1, 0, "이 diff를 보고 예전 코드가 배포된 상태에서 마이그레이션을 돌려도 안전한지 알려 주세요. 먼저 예/아니오, 그다음 이유."],
      ["pull-request-review", 0, 0, "푸시하기 전에 내 변경사항 좀 봐줄래"],
      ["pull-request-review", 0, 1, "동료 PR을 승인하려고 하는데, 결제 흐름을 바꾸는 변경에서는 뭘 봐야 하나요?"],
      [null, 0, 0, "이 코드 괜찮아?"],
      ["pull-request-review", 1, 0, "첨부한 패치를 성능 관점으로만 리뷰해 주세요. N+1 쿼리나 끝없는 반복이 있나요? 파일:줄 형식의 목록으로."],
      ["pull-request-review", 0, 1, "제가 쓴 PR인데 솔직하게, 시니어 엔지니어라면 어디를 지적할까요?"],
    ],
  },
  test: {
    en: [
      ["unit-tests", 1, 0, "Write unit tests for suppress() covering: no small counts, one small count that hides the next smallest, all zeros, and a minimum of 5. Use node:test, one assertion per case."],
      ["unit-tests", 0, 0, "add tests for this function"],
      ["end-to-end-tests", 1, 0, "Write a Playwright test for sign-in through device code: start authorize, approve as admin in the browser, poll until the key arrives. Must run headless in CI under 30 seconds."],
      ["end-to-end-tests", 0, 0, "we need an e2e test for checkout"],
      ["unit-tests", 1, 0, "Our date helpers have no tests. Cover week start in Asia/Seoul and America/New_York across a DST change, with expected values written out."],
      [null, 0, 0, "increase our test coverage"],
      ["end-to-end-tests", 0, 0, "test the whole invite flow end to end"],
      ["unit-tests", 0, 1, "What's the difference between mocking the database and using the embedded Postgres for these tests? Which should I use?"],
    ],
    ko: [
      ["unit-tests", 1, 0, "suppress()의 단위 테스트를 작성해 주세요. 작은 값이 없을 때, 작은 값 하나가 다음으로 작은 값을 가릴 때, 모두 0일 때, 최소값 5일 때. node:test로, 케이스마다 assertion 하나씩."],
      ["unit-tests", 0, 0, "이 함수 테스트 추가해줘"],
      ["end-to-end-tests", 1, 0, "기기 코드 로그인 Playwright 테스트를 작성해 주세요. authorize 시작, 관리자가 브라우저에서 승인, 키가 올 때까지 폴링. CI에서 헤드리스로 30초 안에 돌아야 합니다."],
      ["end-to-end-tests", 0, 0, "결제 E2E 테스트가 필요해"],
      ["unit-tests", 1, 0, "날짜 헬퍼에 테스트가 하나도 없어요. 서머타임 전환을 포함해서 Asia/Seoul과 America/New_York의 주 시작일을 예상값을 직접 적어서 검증해 주세요."],
      [null, 0, 0, "테스트 커버리지 좀 올려줘"],
      ["end-to-end-tests", 0, 0, "초대 흐름 전체를 처음부터 끝까지 테스트해줘"],
      ["unit-tests", 0, 1, "이 테스트에서 DB를 목으로 만드는 것과 내장 Postgres를 쓰는 것의 차이가 뭐예요? 뭘 써야 하나요?"],
    ],
  },
  spec: {
    en: [
      ["product-spec", 1, 0, "Write a one-page spec for letting team leads see their team's insights: problem, who it's for, what they can and can't see, the minimum-group rule, and open questions. Use those five headings."],
      ["product-spec", 0, 0, "write a PRD for the new sharing feature"],
      ["project-plan", 1, 0, "Plan the migration from Crew's ingest to the console's: milestones with owners and dates for the next 6 weeks, dependencies, and the risks with a mitigation each. As a table."],
      ["project-plan", 0, 0, "help me plan the Q1 roadmap"],
      ["product-spec", 0, 0, "We want customers to be able to export insights. Spec it."],
      [null, 0, 0, "write down what we decided in the meeting"],
      ["project-plan", 1, 0, "Break the classifier evaluation into tasks of a day or less, in order, with what 'done' means for each."],
      ["product-spec", 0, 1, "Read my draft spec. Is the scope too big for one quarter?"],
    ],
    ko: [
      ["product-spec", 1, 0, "팀장이 자기 팀 인사이트를 보는 기능의 한 장짜리 기획서를 써 주세요. 문제, 대상, 볼 수 있는 것과 없는 것, 최소 그룹 규칙, 남은 질문. 이 다섯 제목으로."],
      ["product-spec", 0, 0, "새 공유 기능 PRD 써줘"],
      ["project-plan", 1, 0, "Crew 수집에서 콘솔 수집으로 옮기는 계획을 세워 주세요. 앞으로 6주의 마일스톤과 담당자, 날짜, 의존 관계, 리스크마다 대응 방안. 표로."],
      ["project-plan", 0, 0, "1분기 로드맵 계획 좀 도와줘"],
      ["product-spec", 0, 0, "고객이 인사이트를 내보낼 수 있게 하고 싶어. 기획해줘"],
      [null, 0, 0, "회의에서 결정한 거 정리해줘"],
      ["project-plan", 1, 0, "분류기 평가 작업을 하루 이내 단위 작업으로 순서대로 나누고, 각각 '완료'의 기준을 적어 주세요."],
      ["product-spec", 0, 1, "제 기획서 초안을 읽어 봐 주세요. 한 분기에 하기엔 범위가 너무 큰가요?"],
    ],
  },
  design: {
    en: [
      ["ui-mockup", 1, 0, "Mock up the Insights overview page for an admin: hero sentence, four tiles, teams table, and a 'worth a look' panel. Use the design system tokens, desktop at 1440 wide, light theme."],
      ["ui-mockup", 0, 0, "design a settings screen for teams"],
      ["marketing-visual", 1, 0, "Make three directions for the launch banner, 1200x630, Redrob blue, headline 'See how your team works with AI', no stock photos of people."],
      ["marketing-visual", 0, 0, "need a graphic for the blog post"],
      ["ui-mockup", 1, 0, "Redesign the empty state for Explore when fewer than 3 people match: say why nothing is shown and offer to remove a filter. Mobile and desktop."],
      [null, 0, 0, "make it look better"],
      ["marketing-visual", 0, 0, "an illustration for the onboarding email"],
      ["ui-mockup", 0, 1, "Does this dashboard layout have too much on it? Screenshot attached."],
    ],
    ko: [
      ["ui-mockup", 1, 0, "관리자용 인사이트 개요 페이지 시안을 만들어 주세요. 핵심 문장, 타일 네 개, 팀 표, '살펴볼 것' 패널. 디자인 시스템 토큰 사용, 데스크톱 1440 너비, 라이트 테마."],
      ["ui-mockup", 0, 0, "팀 설정 화면 디자인해줘"],
      ["marketing-visual", 1, 0, "출시 배너 시안 세 가지를 1200x630으로 만들어 주세요. 레드롭 블루, 헤드라인은 'AI와 일하는 팀의 모습을 보세요', 인물 스톡 사진은 쓰지 말고요."],
      ["marketing-visual", 0, 0, "블로그 글에 넣을 그래픽이 필요해"],
      ["ui-mockup", 1, 0, "조건에 맞는 사람이 3명 미만일 때 탐색 화면의 빈 상태를 다시 디자인해 주세요. 왜 아무것도 안 보이는지 말하고 필터 제거를 제안하도록. 모바일과 데스크톱 둘 다."],
      [null, 0, 0, "좀 더 예쁘게 만들어줘"],
      ["marketing-visual", 0, 0, "온보딩 메일에 넣을 일러스트"],
      ["ui-mockup", 0, 1, "이 대시보드 레이아웃 너무 복잡한가요? 스크린샷 첨부했어요."],
    ],
  },
  copy: {
    en: [
      ["blog-post", 1, 0, "Write a 900-word blog post for engineering managers on measuring AI adoption without surveillance. Open with a concrete example, three sections, end with what to do this week. Plain words."],
      ["blog-post", 0, 0, "write a blog post about our new feature"],
      ["landing-page-copy", 1, 0, "Landing page copy for Insights: headline under 8 words, subhead under 20, three benefit blocks of 25 words each, and one CTA. Audience is a head of operations."],
      ["landing-page-copy", 0, 0, "rewrite the pricing page copy"],
      ["social-post", 1, 0, "LinkedIn post announcing the Korean launch, under 600 characters, one emoji at most, ends with the signup link."],
      ["social-post", 0, 0, "tweet about the release"],
      [null, 0, 0, "write some marketing copy"],
      ["landing-page-copy", 0, 1, "Which of these two headlines is clearer, and why?"],
    ],
    ko: [
      ["blog-post", 1, 0, "엔지니어링 매니저를 위한 블로그 글을 써 주세요. 감시 없이 AI 도입을 측정하는 방법, 3,000자 내외, 구체적인 사례로 시작해서 세 부분으로 나누고 이번 주에 할 일로 마무리. 쉬운 말로."],
      ["blog-post", 0, 0, "새 기능 소개 블로그 글 써줘"],
      ["landing-page-copy", 1, 0, "인사이트 랜딩 페이지 문구를 써 주세요. 헤드라인 15자 이내, 서브헤드 40자 이내, 혜택 블록 세 개(각 60자), CTA 하나. 대상은 운영 총괄입니다."],
      ["landing-page-copy", 0, 0, "요금제 페이지 문구 다시 써줘"],
      ["social-post", 1, 0, "한국 출시를 알리는 링크드인 게시글, 600자 이내, 이모지는 최대 하나, 마지막에 가입 링크."],
      ["social-post", 0, 0, "출시 소식 SNS에 올릴 글"],
      [null, 0, 0, "마케팅 문구 좀 써줘"],
      ["landing-page-copy", 0, 1, "이 두 헤드라인 중에 어느 쪽이 더 명확한지, 이유도 알려 주세요."],
    ],
  },
  translate: {
    en: [
      ["korean-and-english-reply", 1, 0, "Translate my reply below into Korean for a customer in Busan. Polite 합니다 style, keep product names in English, don't add anything."],
      ["korean-and-english-reply", 0, 0, "translate this ticket from Korean"],
      ["help-article", 1, 0, "Translate the attached help article on SSO into Korean. Keep the headings, code blocks and links unchanged, and use the terms in our glossary file."],
      ["help-article", 0, 0, "Can you put the getting started guide into Korean?"],
      [null, 0, 0, "translate this"],
      ["korean-and-english-reply", 1, 0, "This customer wrote in Korean. Translate their message to English for me, then translate my answer back, matching their level of formality."],
      ["help-article", 0, 0, "localize the FAQ page for Japan"],
      ["korean-and-english-reply", 0, 1, "Is my Korean in this reply natural, or does it sound like a translation?"],
    ],
    ko: [
      ["korean-and-english-reply", 1, 0, "아래 제 답장을 미국 고객에게 보낼 영어로 번역해 주세요. 정중하지만 딱딱하지 않게, 제품명은 그대로, 내용은 더하지 말고요."],
      ["korean-and-english-reply", 0, 0, "이 영어 티켓 번역해줘"],
      ["help-article", 1, 0, "첨부한 SSO 도움말 문서를 영어로 번역해 주세요. 제목, 코드 블록, 링크는 그대로 두고 용어집 파일의 용어를 써 주세요."],
      ["help-article", 0, 0, "시작 가이드 영어로 옮겨줄 수 있어?"],
      [null, 0, 0, "이거 번역해줘"],
      ["korean-and-english-reply", 1, 0, "고객이 영어로 문의했어요. 먼저 한국어로 옮겨 주시고, 제 답변을 고객과 같은 격식 수준의 영어로 다시 번역해 주세요."],
      ["help-article", 0, 0, "FAQ 페이지 일본어로 현지화해줘"],
      ["korean-and-english-reply", 0, 1, "이 답장 영어 표현이 자연스러운가요, 아니면 번역투인가요?"],
    ],
  },
  policy: {
    en: [
      ["contract-review", 1, 0, "Review the attached MSA from the customer's side. Flag anything on liability caps, data processing, auto-renewal and termination that differs from our standard terms (also attached). Table: clause, theirs, ours, risk."],
      ["contract-review", 0, 0, "can you check this contract"],
      ["policy-draft", 1, 0, "Draft an internal policy on using AI tools with customer data: what's allowed, what needs approval, what's never allowed, and who to ask. One page, plain language, for all staff."],
      ["policy-draft", 0, 0, "write a remote work policy"],
      ["contract-review", 1, 0, "Does this NDA allow us to share the customer's name in a case study? Quote the clause and answer yes, no or unclear."],
      [null, 0, 0, "what are the legal risks here"],
      ["policy-draft", 0, 0, "update our data retention policy"],
      ["contract-review", 0, 1, "Explain what an indemnification clause actually does, using this contract as the example."],
    ],
    ko: [
      ["contract-review", 1, 0, "첨부한 고객사 기본계약서를 검토해 주세요. 책임 한도, 개인정보 처리, 자동 갱신, 해지 조항 중 우리 표준 약관(첨부)과 다른 부분을 표시해 주세요. 표: 조항, 상대방 안, 우리 안, 리스크."],
      ["contract-review", 0, 0, "이 계약서 좀 봐줄래?"],
      ["policy-draft", 1, 0, "고객 데이터를 다룰 때 AI 도구 사용에 관한 사내 정책 초안을 써 주세요. 허용되는 것, 승인이 필요한 것, 절대 안 되는 것, 문의처. 전 직원 대상, 한 장, 쉬운 말로."],
      ["policy-draft", 0, 0, "재택근무 정책 써줘"],
      ["contract-review", 1, 0, "이 비밀유지계약서상 고객사 이름을 사례 연구에 써도 되나요? 해당 조항을 인용하고 가능, 불가, 불분명 중 하나로 답해 주세요."],
      [null, 0, 0, "여기 법적 리스크가 뭐야"],
      ["policy-draft", 0, 0, "데이터 보관 정책 업데이트해줘"],
      ["contract-review", 0, 1, "면책 조항이 실제로 무슨 역할을 하는지 이 계약서를 예로 설명해 주세요."],
    ],
  },
  hr: {
    en: [
      ["job-description", 1, 0, "Job description for a senior backend engineer in Seoul: 5+ years, NestJS and Postgres, hybrid 3 days. Sections: the role, what you'll do (5 bullets), what you bring (5 bullets), salary band 90-120M KRW. No 'rockstar'."],
      ["job-description", 0, 0, "write a JD for a designer"],
      ["review-summary", 1, 0, "Summarize these five peer reviews of one engineer into strengths, growth areas and one suggested goal for next half. Neutral tone, no direct quotes, under 250 words."],
      ["review-summary", 0, 0, "summarize the feedback for my report's review"],
      ["onboarding-plan", 1, 0, "30-60-90 day onboarding plan for a new customer success manager: a goal, three activities and how we'll know it worked, for each period. As a table."],
      ["onboarding-plan", 0, 0, "make an onboarding plan for the new hire starting Monday"],
      [null, 0, 0, "help me write an offer letter"],
      ["review-summary", 0, 1, "I wrote this self-review. Does it undersell what I did?"],
    ],
    ko: [
      ["job-description", 1, 0, "서울 근무 시니어 백엔드 엔지니어 채용 공고를 써 주세요. 경력 5년 이상, NestJS와 Postgres, 주 3일 출근. 구성: 직무 소개, 하는 일(5개), 자격 요건(5개), 연봉 9천만~1억 2천만 원. 과장된 표현 없이."],
      ["job-description", 0, 0, "디자이너 채용 공고 써줘"],
      ["review-summary", 1, 0, "엔지니어 한 명에 대한 동료 평가 다섯 개를 강점, 성장 영역, 다음 반기 목표 하나로 요약해 주세요. 중립적인 어조로, 직접 인용 없이, 600자 이내."],
      ["review-summary", 0, 0, "팀원 평가 피드백 요약해줘"],
      ["onboarding-plan", 1, 0, "신규 고객성공 매니저의 30-60-90일 온보딩 계획을 표로 만들어 주세요. 기간마다 목표 하나, 활동 세 가지, 잘 됐는지 아는 방법."],
      ["onboarding-plan", 0, 0, "월요일에 오는 신입 온보딩 계획 짜줘"],
      [null, 0, 0, "처우 제안서 쓰는 것 좀 도와줘"],
      ["review-summary", 0, 1, "제가 쓴 자기 평가인데, 한 일을 너무 낮춰 쓴 것 같나요?"],
    ],
  },
  finance: {
    en: [
      ["month-end-reconciliation", 1, 0, "Reconcile the September bank export against the ledger export, both attached. List unmatched lines on each side with amount and date, and the net difference. Match within 2 days and exact amount."],
      ["month-end-reconciliation", 0, 0, "help me close the books for this month"],
      ["invoice-check", 1, 0, "Check these 12 vendor invoices against the POs: flag any where quantity, unit price or tax differs, and show the difference in KRW. One row per invoice."],
      ["invoice-check", 0, 0, "is this invoice correct?"],
      ["month-end-reconciliation", 0, 0, "the credit card statement doesn't match our expenses sheet"],
      [null, 0, 0, "make a budget for next year"],
      ["invoice-check", 1, 0, "Does the Stonebridge invoice charge for 120 seats when the contract says 100? Answer yes or no, then the line that shows it."],
      ["month-end-reconciliation", 0, 1, "Walk me through how accruals should work at month end. I keep getting this wrong."],
    ],
    ko: [
      ["month-end-reconciliation", 1, 0, "첨부한 9월 은행 거래 내역과 원장 내역을 대사해 주세요. 양쪽의 불일치 항목을 금액, 날짜와 함께 나열하고 순차이를 알려 주세요. 날짜는 2일 이내, 금액은 정확히 일치해야 매칭입니다."],
      ["month-end-reconciliation", 0, 0, "이번 달 결산 좀 도와줘"],
      ["invoice-check", 1, 0, "거래처 송장 12건을 발주서와 대조해서 수량, 단가, 세금이 다른 건을 표시하고 차액을 원화로 보여 주세요. 송장마다 한 행."],
      ["invoice-check", 0, 0, "이 세금계산서 맞아?"],
      ["month-end-reconciliation", 0, 0, "법인카드 명세서랑 경비 시트가 안 맞아"],
      [null, 0, 0, "내년 예산 짜줘"],
      ["invoice-check", 1, 0, "계약서에는 100석인데 스톤브리지 송장에 120석이 청구됐나요? 예/아니오로 답하고 해당 줄을 보여 주세요."],
      ["month-end-reconciliation", 0, 1, "월말 미지급 비용 처리를 어떻게 해야 하는지 차근차근 설명해 주세요. 자꾸 틀려요."],
    ],
  },
};

/**
 * Cases a classifier is most likely to get wrong. A null action is a correct "not labeled": the
 * instruction is personal, too vague, or genuinely between kinds of work.
 */
const HARD: ReadonlyArray<readonly [lang: WorkSample["lang"], action: string | null, ...Row]> = [
  ["en", null, null, 0, 0, "what's a good restaurant near Gangnam station for a team dinner of 8"],
  ["ko", null, null, 0, 0, "주말에 부산 여행 일정 짜줘"],
  ["en", null, null, 0, 0, "hi"],
  ["ko", null, null, 0, 0, "안녕"],
  ["en", null, null, 0, 0, "continue"],
  ["ko", null, null, 0, 0, "계속해"],
  ["en", null, null, 0, 1, "What is the capital of Australia?"],
  ["ko", null, null, 0, 1, "양자컴퓨터가 뭐야?"],
  ["en", null, null, 0, 0, "help me write a birthday message for my mom"],
  ["ko", null, null, 0, 0, "아이 숙제 수학 문제 같이 풀어줘"],
  ["en", null, null, 0, 0, "recommend a sci-fi novel for my flight tomorrow"],
  ["ko", null, null, 0, 0, "저녁 메뉴 추천해줘. 냉장고에 두부랑 김치 있어"],
  ["en", null, null, 0, 1, "explain how mortgages work in Korea, I'm thinking of buying an apartment"],
  ["ko", null, null, 0, 1, "블랙홀은 왜 빛도 못 빠져나와?"],
  ["en", null, null, 0, 0, "thanks, that's perfect"],
  ["ko", null, null, 0, 0, "고마워 완벽해"],
  ["en", null, null, 0, 0, "write a short poem about autumn in Seoul"],
  ["ko", null, null, 0, 0, "친구 결혼식 축사 써줘"],
  ["en", null, null, 0, 0, "do the thing we talked about"],
  ["ko", null, null, 0, 0, "아까 그거 다시 해줘"],
  ["mixed", "reply", "refund-request", 1, 0, "이 고객 refund request에 답장 써줘. 5 business days 안에 처리된다고, 150자 이내로."],
  ["mixed", "fix", "failing-test", 0, 0, "billing test 깨졌어, fix 해줘"],
  ["mixed", "email", "demo-follow-up", 0, 0, "어제 demo 들은 Meridian 쪽에 follow-up email 보내줘"],
  ["mixed", "code", "new-endpoint", 1, 0, "GET /v1/teams endpoint 추가해줘. admin만 접근 가능하고 integration test 포함해서."],
  ["mixed", "analyze", "churn-analysis", 0, 0, "churn data 보고 왜 떠났는지 analysis 해줘"],
  ["en", "translate", "korean-and-english-reply", 0, 0, "reply to this Korean customer in Korean, they asked about the refund"],
  ["ko", "translate", "help-article", 0, 0, "도움말 문서 영어판 만들어줘"],
  ["en", "summ", "call-notes", 0, 0, "Summarize the call and draft the follow-up email"],
  ["ko", "research", "competitor-scan", 0, 0, "경쟁사 가격 조사해서 우리 가격 바꿀지 기획안까지 써줘"],
  ["en", "review", "pull-request-review", 0, 0, "check if this PR fixes the bug in the ticket"],
  ["ko", "fix", null, 0, 0, "PR 리뷰에서 지적받은 거 고쳐줘"],
  ["en", "test", "unit-tests", 0, 0, "the function has no tests and a bug, add tests that show the bug first"],
  ["en", "policy", "contract-review", 0, 0, "red-line this"],
  ["ko", "finance", "invoice-check", 0, 0, "이 청구서 이상한 데 없나 봐줘"],
  ["en", "hr", "job-description", 0, 0, "we're hiring a PM, need the posting by tomorrow"],
  ["ko", "copy", "social-post", 1, 0, "인스타 캡션 세 개, 각 100자 이내, 해시태그 두 개씩"],
  ["en", "design", "ui-mockup", 0, 0, "wireframe"],
  ["ko", "spec", "project-plan", 0, 0, "다음 스프린트 뭐 할지 정리"],
  ["en", "reply", "how-to-answer", 0, 0, "[PERSON_1] from [ORG_1] is asking how to reset 2FA, answer them"],
  ["ko", "email", "renewal-note", 0, 0, "[ORG_1] 담당자 [PERSON_1]님께 계약 갱신 안내 메일 보내줘"],
];

const LANGS: ReadonlyArray<"en" | "ko"> = ["en", "ko"];

const toSample = (id: string, lang: WorkSample["lang"], source: WorkSample["source"], action: string | null, row: Row): WorkSample => ({
  id,
  lang,
  source,
  action,
  task: row[0],
  brief: row[1] === 1,
  learn: row[2] === 1,
  text: row[3],
});

export const WORK_SAMPLES: WorkSample[] = [
  ...Object.entries(PLAIN).flatMap(([action, rows]) =>
    LANGS.flatMap((lang) => rows[lang].map((row, i) => toSample(`${action}-${lang}-${i + 1}`, lang, "plain", action, row))),
  ),
  ...HARD.map(([lang, action, ...row], i) => toSample(`hard-${i + 1}`, lang, "hard", action, row)),
];

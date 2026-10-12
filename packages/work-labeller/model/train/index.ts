/*
 * The work classifier's training set: about 30 first messages per kind of work in each language,
 * plus asking-to-learn and not-about-work examples, all hand-written for training.
 *
 * Kept apart from the evaluation set (eval/work-samples.ts): `train.test.ts` fails if any example
 * here is, or contains, an evaluation message. The classifier learns from these and the prototypes
 * only; the evaluation set is used for the final score and nothing else.
 */
import type { TrainingRows } from "./types.js";
import { CONTRAST } from "./contrast.js";
import { SHEET_CODE_DESIGN } from "./sheet-code-design.js";
import { WRITE_A } from "./write-a.js";
import { WRITE_B } from "./write-b.js";

export type TrainingExample = { action: string | null; learn: boolean; lang: "en" | "ko"; text: string };

const ROWS: TrainingRows = { ...WRITE_A, ...WRITE_B, ...SHEET_CODE_DESIGN };

/** Asking for an explanation, or a review of one's own work, rather than for the work itself. */
const LEARN: { en: readonly string[]; ko: readonly string[] } = {
  en: [
    "How does OAuth actually work? Explain it simply.",
    "What's the difference between a left join and an inner join?",
    "Can you explain what deferred revenue means?",
    "I wrote this reply to a customer, is the tone right?",
    "Why would someone use a message queue here?",
    "Teach me how to read a cash flow statement",
    "What does this error message mean?",
    "Is my approach to this function reasonable, or am I overcomplicating it?",
    "Explain what a p-value tells me in an A/B test",
    "What makes a good job description?",
    "Help me understand how our pricing tiers differ",
    "How should I think about prioritizing features?",
    "Give me feedback on my presentation outline",
    "What is a race condition, with an example?",
    "Explain the difference between gross and net revenue retention",
    "Am I reading this contract clause correctly?",
    "How do I get better at writing cold emails?",
    "What's the point of an indemnity clause?",
    "Can you walk me through how Kubernetes scheduling works?",
    "Here is my draft blog post, what would make it stronger?",
    "Explain how accrual accounting differs from cash accounting",
    "What should I look for when reviewing a pull request?",
    "What are the pros and cons of microservices?",
    "Is this a good way to structure a spreadsheet model?",
    "Explain like I'm new: what does a product manager do day to day?",
  ],
  ko: [
    "OAuth가 실제로 어떻게 동작하는지 쉽게 설명해줘",
    "레프트 조인이랑 이너 조인 차이가 뭐야?",
    "선수수익이 무슨 뜻인지 설명해 주실래요?",
    "고객한테 이렇게 답장 썼는데 톤 괜찮아?",
    "여기서 메시지 큐를 왜 쓰는 거야?",
    "현금흐름표 보는 법 알려 주세요",
    "이 에러 메시지가 무슨 뜻이야?",
    "이 함수 접근 방식 괜찮아? 너무 복잡하게 하는 건가?",
    "A/B 테스트에서 p값이 뭘 말해 주는지 설명해줘",
    "좋은 채용 공고의 조건이 뭘까요?",
    "우리 요금제 등급이 어떻게 다른지 이해하게 도와줘",
    "기능 우선순위는 어떻게 생각해야 해?",
    "발표 개요 피드백 좀 주세요",
    "경쟁 조건이 뭔지 예시랑 같이 설명해줘",
    "총 매출 유지율과 순 매출 유지율 차이 설명해 주세요",
    "이 계약 조항 제가 제대로 이해한 건가요?",
    "콜드메일 잘 쓰려면 어떻게 해야 해?",
    "면책 조항은 왜 있는 거예요?",
    "쿠버네티스 스케줄링이 어떻게 돌아가는지 차근차근 알려줘",
    "블로그 초안인데 어떻게 하면 더 좋아질까요?",
    "발생주의 회계랑 현금주의 회계 차이 설명해줘",
    "PR 리뷰할 때 뭘 봐야 하나요?",
    "마이크로서비스 장단점이 뭐야?",
    "스프레드시트 모델 이렇게 짜는 게 맞아?",
    "신입 눈높이로 PM이 하루에 뭐 하는지 설명해 주세요",
  ],
};

/** Not about work: personal asks, small talk, and messages with nothing to classify. */
const NONE: { en: readonly string[]; ko: readonly string[] } = {
  en: [
    "what should I get my sister for her birthday",
    "recommend a good movie for tonight",
    "how long should I boil an egg",
    "write a funny poem about my cat",
    "plan a weekend trip to Jeju",
    "what's a healthy breakfast",
    "translate 'good morning' into French for my kid's homework",
    "help me write a wedding toast for my friend",
    "yes",
    "no that's fine",
    "thank you!",
    "keep going",
    "do it again",
    "hmm",
    "can you try once more",
    "what time is it in London",
    "suggest names for my new puppy",
    "what's the weather like in Busan this weekend",
    "tell me something interesting",
    "write a bedtime story about a dragon",
    "how do I get a stain out of a shirt",
    "best way to learn guitar as an adult",
    "make a grocery list for a week of dinners",
    "who won the football match last night",
    "never mind",
  ],
  ko: [
    "여동생 생일 선물 뭐가 좋을까",
    "오늘 밤에 볼 영화 추천해줘",
    "계란 몇 분 삶아야 해",
    "우리 고양이에 대한 웃긴 시 써줘",
    "제주도 주말 여행 계획 짜줘",
    "건강한 아침 메뉴 뭐가 있어",
    "아이 숙제로 '좋은 아침'을 프랑스어로 뭐라고 해",
    "친구 결혼식 건배사 쓰는 거 도와줘",
    "응",
    "아니 괜찮아",
    "감사합니다!",
    "계속 해줘",
    "다시 한번 해줘",
    "음",
    "한 번만 더 해볼래?",
    "런던은 지금 몇 시야",
    "새로 데려온 강아지 이름 추천해줘",
    "이번 주말 부산 날씨 어때",
    "재밌는 얘기 해줘",
    "용이 나오는 잠자리 동화 써줘",
    "셔츠 얼룩 지우는 법",
    "어른이 기타 배우기 좋은 방법",
    "일주일 저녁 장보기 목록 만들어줘",
    "어젯밤 축구 경기 누가 이겼어",
    "됐어 신경 쓰지 마",
  ],
};

const LANGS: readonly ("en" | "ko")[] = ["en", "ko"];

export const TRAINING_EXAMPLES: TrainingExample[] = [
  ...Object.entries(ROWS).flatMap(([action, rows]) =>
    LANGS.flatMap((lang) => rows[lang].map((text) => ({ action, learn: false, lang, text }))),
  ),
  ...LANGS.flatMap((lang) => LEARN[lang].map((text) => ({ action: null, learn: true, lang, text }))),
  ...LANGS.flatMap((lang) => NONE[lang].map((text) => ({ action: null, learn: false, lang, text }))),
  ...Object.entries(CONTRAST).flatMap(([action, rows]) =>
    LANGS.flatMap((lang) => rows[lang].map((text) => ({ action, learn: false, lang, text }))),
  ),
];

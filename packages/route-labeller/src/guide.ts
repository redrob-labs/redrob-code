
/*
 * The ModelGuide edition Redrob Auto routes on, read from Console's `GET /v1/guide`, and turned into
 * the props of the ModelGuide component in @redrob-labs/ui.
 *
 * Shared so Cowork, Office and Design render the guide the same way, from the same edition the
 * router reads, rather than each bundling a copy that is right until the next monthly edition. The
 * Console web app carries the same mapping (apps/web/src/lib/guide/guide.ts) because it cannot
 * depend on this package's workspace.
 */

export type GuideKind = 'measured' | 'published' | 'derived' | 'estimate';
type Label = { en: string; ko: string };

export type GuideEditionPick = {
  id: string;
  rank: number;
  steps: Array<{ model: string; catalogueId: string; effort?: string; role?: 'image' }>;
  harness: string;
  kind: GuideKind;
  score: { quality: number; reliability: number; speed: number; cost: number; ci: number };
  monthly: number;
  monthlyKind: GuideKind;
  monthlyRange: [number, number];
  efforts: Array<[string, number]>;
  comingSoon: boolean;
  missing: string[];
  flags: string[];
  sources: Array<{
    label: string;
    value: string;
    kind: GuideKind;
    url?: string;
    date: string;
    model?: string;
  }>;
};

export type GuideEditionResponse = {
  asOf: string;
  editions: string[];
  harness: string;
  weights: { quality: number; reliability: number; speed: number; cost: number };
  models: Record<string, string>;
  professions: Array<{
    id: string;
    label: Label;
    tasks: Array<{
      id: string;
      label: Label;
      runs: number;
      tools: string[];
      picks: Record<string, GuideEditionPick[]>;
    }>;
  }>;
};

/**
 * The live edition from a Console deployment, e.g. `https://console.redrob.ai/api/backend/v1`.
 * Null rather than throwing: a guide page says the guide is unavailable instead of failing.
 */
export async function fetchGuide(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GuideEditionResponse | null> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/guide`);
    if (!response.ok) return null;
    return (await response.json()) as GuideEditionResponse;
  } catch {
    return null;
  }
}

/*
 * The props the ModelGuide component in @redrob-labs/ui reads, restated structurally so this package
 * does not depend on React or the design system. Assignable to `GuideProfession[]` as they stand.
 */
type GuideEffort = { label: string; level?: number; of?: number };
type GuideSource = { label: string; value?: string; kind?: GuideKind; url?: string; date?: string };
type GuideTool = { label: string; soon?: boolean; missing?: boolean };
export type GuidePick = {
  id: string;
  model?: string;
  steps?: Array<{ model: string; effort?: GuideEffort; role?: string }>;
  harness?: string;
  kind?: GuideKind;
  score?: GuideEditionPick['score'];
  monthly?: number;
  monthlyKind?: GuideKind;
  monthlyRange?: [number, number];
  effort?: GuideEffort;
  efforts?: Array<GuideEffort & { monthly?: number }>;
  tools?: GuideTool[];
  flags?: string[];
  why?: string;
  sources?: GuideSource[];
};
export type GuideProfession = {
  id: string;
  label: string;
  tasks: Array<{
    id: string;
    label: string;
    title: string;
    usage: string;
    picks: GuidePick[];
    picksByLanguage: Record<string, GuidePick[]>;
  }>;
};

export type GuideLocale = 'en' | 'ko';

/** The working languages the guide ranks, for the component's language select. */
export function guideLanguages(locale: GuideLocale): Array<{ value: string; label: string }> {
  return [
    { value: 'en', label: localeText(locale, 'English', '영어') },
    { value: 'ko', label: localeText(locale, 'Korean', '한국어') },
    { value: 'hi', label: localeText(locale, 'Hindi', '힌디어') },
  ];
}

const EFFORTS: Record<string, Label> = {
  none: { en: 'None', ko: '없음' },
  minimal: { en: 'Minimal', ko: '최소' },
  low: { en: 'Low', ko: '낮음' },
  medium: { en: 'Medium', ko: '중간' },
  high: { en: 'High', ko: '높음' },
  xhigh: { en: 'Extra high', ko: '매우 높음' },
  max: { en: 'Max', ko: '최대' },
  default: { en: 'Default', ko: '기본' },
};

const TOOLS: Record<string, Label> = {
  browser: { en: 'Browser', ko: '브라우저' },
  calendar: { en: 'Calendar', ko: '캘린더' },
  'code-execution': { en: 'Code execution', ko: '코드 실행' },
  crm: { en: 'CRM', ko: 'CRM' },
  email: { en: 'Email', ko: '이메일' },
  'file-read': { en: 'Files', ko: '파일' },
  'graphic-design': { en: 'Graphic design', ko: '그래픽 디자인' },
  'pdf-generation': { en: 'PDF', ko: 'PDF' },
  presentation: { en: 'Slides', ko: '슬라이드' },
  spreadsheet: { en: 'Spreadsheet', ko: '스프레드시트' },
  'ui-ux-design': { en: 'UI/UX design', ko: 'UI/UX 디자인' },
  'web-search': { en: 'Web search', ko: '웹 검색' },
};

const FLAGS: Record<string, Label> = {
  'close-call': { en: 'Close call', ko: '근소한 차이' },
  'partly-estimated': { en: 'Partly estimated', ko: '일부 추정' },
  'outside-us': { en: 'Served outside the US', ko: '미국 외 지역에서 제공' },
  'data-policy-unverified': { en: 'Data policy unverified', ko: '데이터 정책 미확인' },
  retiring: { en: 'Retiring', ko: '지원 종료 예정' },
};

const HARNESSES: Record<string, Label> = {
  'redrob-desk': { en: 'Redrob Auto', ko: '레드롭 Auto' },
};

function named(names: Record<string, Label>, id: string, locale: GuideLocale): string {
  return names[id]?.[locale] ?? id;
}

/**
 * The edition as the ModelGuide component reads it, labelled in the page's language.
 *
 * Every step keeps its catalogue id in `id`-adjacent form so "Use this" can open the playground on the
 * model the router would send, not the guide's display name.
 */
export function guideProfessions(
  edition: GuideEditionResponse,
  locale: GuideLocale
): GuideProfession[] {
  const name = (model: string) => edition.models[model] ?? model;
  return edition.professions.map(profession => ({
    id: profession.id,
    label: profession.label[locale],
    tasks: profession.tasks.map(task => {
      const byLanguage = Object.fromEntries(
        Object.entries(task.picks).map(([language, picks]) => [
          language,
          picks.map((pick): GuidePick => {
            const ranked = pick.steps[0]?.effort;
            const of = pick.efforts.length;
            const at = pick.efforts.findIndex(([label]) => label === ranked);
            const effort = ranked
              ? {
                  label: named(EFFORTS, ranked, locale),
                  ...(at >= 0 ? { level: at + 1, of } : {}),
                }
              : undefined;
            const sources: GuideSource[] = pick.sources.map(source => ({
              label:
                source.label === 'price'
                  ? `${localeText(locale, 'Price', '가격')}: ${name(source.model ?? '')}`
                  : source.label === 'monthly'
                    ? localeText(locale, 'Monthly cost', '월 비용')
                    : source.label === 'image'
                      ? localeText(locale, 'Image cost', '이미지 비용')
                      : source.label,
              value: source.value,
              kind: source.kind,
              url: source.url,
              date: source.date,
            }));
            const evidence = pick.sources.filter(
              source => !['price', 'monthly', 'image'].includes(source.label)
            );
            const tools: GuideTool[] = task.tools.map(tool => ({
              label: named(TOOLS, tool, locale),
              missing: pick.missing.includes(tool),
            }));
            return {
              id: `${pick.id}|${pick.steps[0]?.catalogueId ?? ''}`,
              ...(pick.steps.length > 1
                ? {
                    steps: pick.steps.map((step, index) => ({
                      model: name(step.model),
                      effort: index === 0 ? effort : undefined,
                      role:
                        step.role === 'image'
                          ? localeText(locale, 'Image', '이미지')
                          : localeText(locale, 'Text', '텍스트'),
                    })),
                  }
                : { model: name(pick.steps[0]?.model ?? '') }),
              harness: named(HARNESSES, pick.harness, locale),
              kind: pick.kind,
              score: pick.score,
              monthly: pick.monthly,
              monthlyKind: pick.monthlyKind,
              monthlyRange: pick.monthlyRange,
              effort,
              efforts: pick.efforts.map(([label, monthly], index) => ({
                label: named(EFFORTS, label, locale),
                level: index + 1,
                of,
                monthly,
              })),
              tools,
              flags: pick.flags.map(flag => named(FLAGS, flag, locale)),
              why: evidence
                .slice(0, 2)
                .map(source => `${source.label}: ${source.value}`)
                .join('; '),
              sources,
            };
          }),
        ])
      );
      return {
        id: task.id,
        label: task.label[locale],
        title: task.label[locale],
        usage: localeText(
          locale,
          `Priced for about ${task.runs} runs a month.`,
          `월 약 ${task.runs}회 실행 기준 가격입니다.`
        ),
        picks: byLanguage.en ?? [],
        picksByLanguage: byLanguage,
      };
    }),
  }));
}

/** The catalogue id a ModelGuide pick runs first, which is what the playground is opened on. */
export function catalogueIdOf(pickId: string): string | null {
  const id = pickId.split('|')[1];
  return id ? id : null;
}

function localeText(locale: GuideLocale, english: string, korean: string): string {
  return locale === 'ko' ? korean : english;
}

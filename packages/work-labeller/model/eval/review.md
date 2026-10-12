# Reviewing the work classifier evaluation set

`work-samples.ts` holds 296 first instructions, the kind of message a person opens a Cowork chat with:

- 128 plain English and 128 plain Korean samples, 8 per kind of work in each language;
- 40 hard cases: things that aren't work, mixed Korean and English, messages too short or vague to place, work that sits between two kinds, and messages with privacy labels like `[PERSON_1]` already in them.

Each sample says what a correct classifier answers. Candidate models are scored against these answers, so a wrong answer here penalises a model for being right. All of the text is made up.

## What to check in each Korean sample

1. **Natural:** it reads like something a Korean colleague would type at work. A sample that reads like a translation is the main thing to catch, because people will write the real ones naturally.
2. **Register:** the plain samples are split on purpose. Each kind of work has a polite, detailed version (합니다 or 해요 style, with a brief) and a terse version (반말, "~해줘"). Both registers should look like real usage.
3. **Kind of work and task:** the first two fields of each row, under the action it's listed under. `null` as the task means the message fits that kind of work but none of its tasks.
4. **`brief`, the second field:** `1` when the message says what done looks like, such as who it's for, the format, the length, or the test that proves it. Saying only what to work on is `0`.
5. **`learn`, the third field:** `1` when the person asks for an explanation, or a review of their own work, rather than for the work itself.

Korean doesn't need to match the English sample beside it. They're separate samples, and a Korean sample that uses a more natural local example (원화 amounts, 세금계산서, 반기 평가) is better.

## How to give feedback

Comment on the pull request against the line, or edit the line directly.

- To flag a sample without rewriting it, comment "unnatural", "wrong label" or "ambiguous".
- An ambiguous sample can stay if the label is the one most people would choose. Otherwise move it to the hard cases.

`pnpm --filter redrob-server test src/insights` checks that every label exists in the console's vocabulary, that every task appears in both languages, and that each kind of work keeps 8 samples per language. Edits that keep that test passing are safe to make.

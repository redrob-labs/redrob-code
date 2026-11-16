import { describe, expect, test } from "bun:test"
import { MobileProfile } from "../src/permission/mobile"
import { isReadOnlyCommand } from "../src/permission/readonly"

describe("read-only commands", () => {
  test.each([
    "grep -rn pasted apps/api --include=*.ts",
    "cat apps/web/package.json",
    "ls -la",
    "rg useComposer apps/web | head -20",
    "find . -name '*.tsx' -not -path './node_modules/*'",
    "git status",
    "git diff --stat",
    "git -C apps/web log --oneline -5",
    "sed -n 60,200p components/chat/search-form/useComposerSubmit.ts",
    "head -50 a.ts && tail -n 20 b.ts",
    "wc -l a b c 2>/dev/null",
    'cd apps/web; f=$(grep -rl "export function useComposerSubmit" --include=*.ts* .); echo $f; cat $f',
    "cd /vercel/sandbox/repo; grep -rn \"pasted\" apps/api --include=*.ts 2>&1 | head",
    "git branch --show-current",
    "/vercel/sandbox/bin/redrob-preview shot /settings --width 390",
  ])("%s", (command) => expect(isReadOnlyCommand(command)).toBe(true))

  test.each([
    "rm -rf node_modules",
    "echo hi > a.txt",
    "cat a >> b",
    "find . -name '*.log' -delete",
    "find . -exec rm {} \\;",
    "sed -i 's/a/b/' x.ts",
    "sed 's/a/b/' x.ts",
    "sed -n 'w out.txt' x",
    "git commit -m x",
    "git push",
    "git checkout develop",
    "git branch -D x",
    "npm install",
    "yarn dev &",
    "cat `which node`",
    "echo $(rm -rf /)",
    "grep x a | tee out.txt",
    "cat <<EOF\nx\nEOF",
    "diff <(ls a) <(ls b)",
    "node -e 'require(\"fs\").rmSync(\"a\")'",
    "env rm -rf x",
    "ls & rm x",
    "",
  ])("not: %s", (command) => expect(isReadOnlyCommand(command)).toBe(false))

  test("edits mode runs read-only commands and still asks for others", () => {
    MobileProfile.mark("s-ro", "edits")
    expect(MobileProfile.decide("s-ro", "bash", "git status && grep -rn x .", "ask")).toBe("allow")
    expect(MobileProfile.decide("s-ro", "bash", "rm -rf x", "ask")).toBe("ask")
    expect(MobileProfile.decide("s-ro", "bash", "git status", "deny")).toBe("deny")
    MobileProfile.mark("s-ro", "ask")
    expect(MobileProfile.decide("s-ro", "bash", "git status", "allow")).toBe("ask")
    MobileProfile.unmark("s-ro")
  })
})

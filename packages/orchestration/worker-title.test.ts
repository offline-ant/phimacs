import assert from "node:assert/strict";
import test from "node:test";
import { workerTitle } from "./worker-title.ts";

const examples = [
  ["Separate READ-ONLY source-contract investigation for STORAGE HOST observability. Do not edit.", "READ-ONLY source-contract investigation for STORAGE HOST…"],
  ["Review only /tmp/tester-installer/report.md for factual consistency. Then report.", "R] report.md for factual consistency"],
  ["Implement only NEW port/storage/reader.c,h + fixtures/reader_fixture.c", "B] reader.c,h + reader_fixture.c"],
  ["Independent subtask: genuinely investigate the new sidebar", "I] independent sidebar"],
  ["Read-only review of the sidebar", "R] read-only sidebar"],
  ["Independently review and verify sidebar ordering", "RV] sidebar ordering"],
  ["Final independent review of sidebar", "R] final independent sidebar"],
  ["Final fresh-eyes review of current diff", "R] final fresh-eyes current diff"],
  ["Review for regressions", "R] regressions"],
  ["Final Plan Review: sidebar", "Final Plan Review: sidebar"],
  ["Read-only investigation of sidebar", "Read-only investigation of sidebar"],
  ["Separate subtask of merge: reapply sidebar commit", "reapply sidebar commit"],
  ["Genuinely separate subtask of phase A: implement sidebar folding", "B] sidebar folding"],
  ["Read-only focused subtask: inspect sidebar ordering", "Read-only focused inspect sidebar ordering"],
  ["Narrow test subtask. Own sidebar tests", "Narrow test"],
  ["You are a fact-gathering worker for the sidebar review. Read files.", "fact-gathering worker for sidebar review"],
  ["You are one of TWO fresh agents testing the sidebar", "fresh agents testing sidebar"],
  ["You own sidebar planning docs", "Own sidebar planning docs"],
  ["Your run was cancelled by timeout. Review the sidebar again.", "R] sidebar again"],
  ["Your launch failed\nFix sidebar ordering", "Fix sidebar ordering"],
  ["Your launch failed transiently", "Your launch failed transiently"],
  ["Review not-only and renewal without changing no-op tests", "R] not-only and renewal without changing no-op tests"],
  ["Investigate do/delegate worker naming", "I] do/delegate worker naming"],
  ["Review request/response ownership and stop/restart handling", "R] request/response ownership and stop/restart handling"],
  ["Review UI/UX and src/components without changes", "R] UI/UX and src/components without changes"],
  ["\n\n## **Review** _only_ `src/new/only.test.ts`\nDo not edit files.", "R] only.test.ts"],
  ["\u001b[31mReview\u001b[0m\t the\u0000 sidebar\u202e\r\nThen test.", "R] sidebar"],
  ["Review [the sidebar](https://example.test/sidebar) and `new_file.ts`.", "R] sidebar and new_file.ts"],
  ["Review src/__init__.py and __init__.py without _changing_ tests", "R] __init__.py and __init__.py without changing tests"],
  ["Review only C:\\source\\new\\reader.test.ts and ./fixtures/a.json.", "R] reader.test.ts and a.json"],
  ["Review ~/docs/new and /tmp/only; preserve src/a.", "R] new and only; preserve src/a"],
  ["Review (src/new/api.ts), then test.", "R] (api.ts), then test"],
  ["Check report.test.ts! Then investigate errors.", "Check report.test.ts"],
  ["Review https://example.test/new/api.ts without access.", "R] https://example.test/new/api.ts without access"],
  ["```text\nReview the sidebar\n```", "R] sidebar"],
  ["---\n> Review the sidebar\nThen test.", "R] sidebar"],
  ["The only separate distinct subtask", "The only separate distinct subtask"],
  ["The only separate independent subtask", "independent"],
  ["   \n\u001b[31m\u001b[0m\n***", "Worker"],
  ["rEvIeW the sidebar", "R] sidebar"],
  ["IMPLEMENT sidebar folding", "B] sidebar folding"],
  ["INVESTIGATE sidebar ordering", "I] sidebar ordering"],
  ["vErIfY sidebar ordering", "V] sidebar ordering"],
  ["Review", "R]"],
  ["Review: sidebar", "R] sidebar"],
  ["Implement: sidebar folding", "B] sidebar folding"],
  ["Investigate: sidebar ordering", "I] sidebar ordering"],
  ["Verify: sidebar ordering", "V] sidebar ordering"],
  ["Review and implement: sidebar changes", "RB] sidebar changes"],
  ["Review: & Verify: sidebar changes", "RV] sidebar changes"],
  ["Review:sidebar", "Review:sidebar"],
  ["Review:: sidebar", "Review:: sidebar"],
  ["Review.ts: notes", "Review.ts: notes"],
  ["/tmp/Review: sidebar", "Review: sidebar"],
  ["Plan Review: sidebar", "Plan Review: sidebar"],
  ["## **Review** only and _IMPLEMENT_ new src/sidebar.ts", "RB] sidebar.ts"],
  ["Investigate & verify sidebar ordering", "IV] sidebar ordering"],
  ["Fix and verify sidebar ordering", "Fix and verify sidebar ordering"],
  ["Review and implement reliable backup verification runner", "RB] reliable backup verification runner"],
  ["Review and do not implement sidebar changes", "R] and do not implement sidebar changes"],
  ["Review then implement sidebar changes", "R] then implement sidebar changes"],
  ["Review and audit sidebar changes", "R] and audit sidebar changes"],
  ["Review and implement then verify sidebar changes", "RB] then verify sidebar changes"],
  ["Audit sidebar changes", "Audit sidebar changes"],
  ["Build sidebar changes", "B] sidebar changes"],
  ["Build: sidebar changes", "B] sidebar changes"],
  ["Implement and build sidebar changes", "BB] sidebar changes"],
  ["Review the actual agreed sidebar changes", "R] sidebar changes"],
  ["Review and actually verify sidebar ordering", "RV] sidebar ordering"],
  ["Plan Review and Implement work", "Plan Review and Implement work"],
  ["Reviewer and Implementation details", "Reviewer and Implementation details"],
  ["Fixup and Verifyable details", "Fixup and Verifyable details"],
  ["Investigate-only sidebar ordering", "Investigate-only sidebar ordering"],
  ["Review.ts and Implement.ts", "Review.ts and Implement.ts"],
  ["/tmp/Review and Implement sidebar changes", "Review and Implement sidebar changes"],
  ["Review /tmp/and Implement sidebar changes", "R] and Implement sidebar changes"],
  ["Review and /tmp/Implement sidebar changes", "R] and Implement sidebar changes"],
  ["C:\\source\\Fix src/Verify.ts", "Fix Verify.ts"],
] as const;

for (const [task, expected] of examples) {
  test(`worker title: ${JSON.stringify(task)}`, () => {
    assert.equal(workerTitle(task), expected);
  });
}

test("explicit leading action combinations retain their order", () => {
  const actions = [["Review", "R"], ["Implement", "B"], ["Build", "B"], ["Investigate", "I"],
    ["Verify", "V"]] as const;
  for (const [first, firstPrefix] of actions) {
    for (const [second, secondPrefix] of actions) {
      for (const conjunction of ["and", "&"]) {
        assert.equal(workerTitle(`${first.toUpperCase()} ${conjunction} ${second.toLowerCase()} sidebar`),
          `${firstPrefix}${secondPrefix}] sidebar`);
      }
    }
  }
});

test("worker titles replace actions before truncating at word boundaries within 60 characters", () => {
  assert.equal(workerTitle("Review controller lifecycle routing and synchronization before release across hosts"),
    "R] controller lifecycle routing and synchronization before…");
  assert.equal(workerTitle("Review and implement controller lifecycle routing and synchronization before release across hosts"),
    "RB] controller lifecycle routing and synchronization…");
  assert.equal(workerTitle("x".repeat(60)), "x".repeat(60));
  assert.equal(workerTitle("x".repeat(61)), `${"x".repeat(59)}…`);
  const title = workerTitle("界".repeat(61));
  assert.equal(Array.from(title).length, 60);
  assert.equal(title, `${"界".repeat(59)}…`);
  assert.equal(workerTitle("𠮷".repeat(61)), `${"𠮷".repeat(59)}…`);
  const prefixedUnicode = workerTitle(`Verify ${"𠮷 ".repeat(40)}`);
  assert.ok(prefixedUnicode.startsWith("V] 𠮷 "));
  assert.ok(prefixedUnicode.endsWith("…"));
  assert.ok(Array.from(prefixedUnicode).length <= 60);
});

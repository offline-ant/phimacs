import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { forkFixture } from "../support/orchestration.ts";
import askExtension from "../../packages/extensions/extensions/ask.ts";

type AskResult = {
  content: Array<{ text: string }>;
  details: { results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>; cancelled: boolean };
};
type AskExecute = (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<AskResult>;
type FormComponent = { render: (width: number) => string[]; handleInput: (data: string) => void; dispose: () => void };
type FormFactory = (tui: unknown, theme: unknown, keys: KeybindingsManager, done: (result: unknown) => void) => FormComponent;

const KEY = { up: "\u001b[A", down: "\u001b[B", right: "\u001b[C", tab: "\t", shiftTab: "\u001b[Z", enter: "\r", escape: "\u001b", delete: "\u001b[3~" };

function askFixture() {
  const fixture = forkFixture();
  let execute!: AskExecute;
  Object.assign(fixture.pi, {
    registerTool: (tool: { execute: AskExecute }) => { execute = tool.execute; },
  });
  askExtension(fixture.pi);
  return { ...fixture, execute };
}

/** Opens the TUI form of an ask on a terminal of ROWS rows; returns the component and the ask's result. */
function openForm(fixture: ReturnType<typeof askFixture>, params: unknown, rows = 40, ui: object = {}) {
  let component!: FormComponent;
  let blocked: unknown;
  const result = fixture.execute("form", params, undefined, undefined, {
    hasUI: true, mode: "tui", ui: {
      ...ui,
      custom: (factory: FormFactory, options: { blocked: unknown }) => {
        blocked = options.blocked;
        return new Promise((resolve) => {
          component = factory(
            { requestRender: () => undefined, terminal: { rows } },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            new KeybindingsManager(TUI_KEYBINDINGS),
            (value) => { component.dispose(); resolve(value); },
          );
        });
      },
    },
  });
  const press = (...keys: string[]) => { for (const key of keys) component.handleInput(key); };
  return { result, press, render: (width = 80) => component.render(width), blocked: () => blocked };
}

const questions = [{ id: "choice", question: "Which option?", options: [{ label: "A" }, { label: "B" }], multi: true }];

for (const mode of ["rpc", "tui"] as const) test(`${mode} ask discussion forks before the tool call while keeping question and selections open`, async () => {
  const fixture = askFixture();
  fixture.session.appendMessage({
    role: "assistant", content: [{ type: "toolCall", id: "ask-call", name: "ask", arguments: { questions } }],
    api: "openai-responses", provider: "fixture", model: "fake", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
  const branch = fixture.session.getLeafId();
  let selection = 0;
  let finished = false;
  let started!: () => void;
  const forkStarted = new Promise<void>((resolve) => { started = resolve; });
  const ctx = {
    cwd: fixture.directory, hasUI: true, mode, sessionManager: fixture.session,
    model: { provider: "fixture", id: "fake" }, isIdle: () => false,
    ui: {
      select: async (title: string, choices: string[]) => {
        assert.equal(mode, "rpc", "TUI ask must use its form");
        assert.equal(title, "(1/1) Which option?");
        selection++;
        if (selection === 1) return choices.find((choice) => choice.includes("[ ] A"));
        if (selection === 2) return choices.find((choice) => choice.includes("Fork (discuss separately)"));
        assert.equal(finished, false, "parent ask must remain pending after fork creation");
        assert.equal(fixture.prompts.length, 1);
        assert.ok(choices.some((choice) => choice.includes("[x] A")), "fork must preserve selections");
        return choices.find((choice) => choice.includes("Done selecting"));
      },
      editor: async (_title: string, prefill: string) => {
        assert.ok(prefill.includes("Which option?"));
        assert.ok(prefill.includes("Current answer: [A]"));
        return "Discuss this choice separately";
      },
      custom: async (factory: FormFactory, options: { blocked: { kind: string; message: string } }) => {
        assert.deepEqual(options.blocked, { kind: "question", message: "Which option?" });
        return new Promise((resolve) => {
          const component = factory(
            { requestRender: () => undefined, terminal: { rows: 40 } },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          // Toggle A, then open the fork row: A, B, Other, Fork.
          component.handleInput(KEY.enter);
          for (let move = 0; move < 3; move++) component.handleInput(KEY.down);
          component.handleInput(KEY.enter);
          // The form takes input again once the fork launch settled.
          void forkStarted.then(() => new Promise((settled) => setImmediate(settled))).then(() => {
            assert.equal(finished, false);
            assert.equal(fixture.prompts.length, 1);
            const lines = component.render(100);
            assert.ok(lines.some((line) => line.includes("[x] A")), "the form keeps its selections");
            assert.ok(lines.some((line) => line.includes("(1/1) Which option?")));
            component.handleInput(KEY.down);
            component.handleInput(KEY.enter);
            component.dispose();
          });
        });
      },
      setEditorText: () => assert.fail("must not overwrite parent draft"),
      notify: (text: string) => {
        if (!text.startsWith("Started ")) return;
        fixture.targets.push(text.split(".")[0].slice(8));
        started();
      },
    },
  };
  try {
    const result = await fixture.execute("ask-call", { questions }, undefined, undefined, ctx);
    finished = true;
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(result.details.results[0].selectedOptions, ["A"]);
    assert.deepEqual(fixture.prompts, ["Discuss this choice separately"]);
    assert.equal(fixture.session.getLeafId(), branch);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    const child = SessionManager.open(fixture.children[0]);
    assert.equal(child.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant"), false);
  } finally { await fixture.cleanup(); }
});

test("RPC ask cancellation, edited answers, and unavailable UI are explicit", async () => {
  const fixture = askFixture();
  try {
    const ctx = { hasUI: true, mode: "rpc", ui: { select: async () => undefined } };
    // Cancelling a lone question cancels the ask.
    const cancelled = await fixture.execute("cancel", { questions }, undefined, undefined, ctx);
    assert.equal(cancelled.details.cancelled, true);
    const unavailable = await fixture.execute("none", { questions }, undefined, undefined, { hasUI: false });
    assert.equal(unavailable.details.cancelled, true);
    const edited = await fixture.execute("edit", { questions: [{ ...questions[0], multi: false }] }, undefined, undefined, {
      hasUI: true, mode: "rpc", ui: {
        select: async (title: string, choices: string[]) => {
          if (title === "Edit which option?") {
            assert.deepEqual(choices, ["A", "B"]);
            return "A";
          }
          // One edit entry for all options, before the fork entry; no per-option edit duplicates.
          assert.deepEqual(choices, ["A", "B", "Other (type your own)", "Edit an option as your answer…", "Fork (discuss separately)"]);
          return "Edit an option as your answer…";
        },
        editor: async (_title: string, prefill: string) => `${prefill} with changes`,
      },
    });
    assert.equal(edited.details.cancelled, false);
    assert.equal(edited.details.results[0].customInput, "A with changes");
    assert.equal(fixture.commands.length, 0);
  } finally { await fixture.cleanup(); }
});

test("cancelled discussion editor returns to the same RPC question without spawning", async () => {
  const fixture = askFixture();
  let count = 0;
  try {
    const result = await fixture.execute("cancel-discuss", { questions: [{ ...questions[0], multi: false }] }, undefined, undefined, {
      hasUI: true, mode: "rpc", ui: {
        select: async (_title: string, choices: string[]) => {
          count++;
          return choices.find((choice) => choice === (count === 1 ? "Fork (discuss separately)" : "A"));
        },
        editor: async () => undefined,
      },
    });
    assert.deepEqual(result.details.results[0].selectedOptions, ["A"]);
    assert.equal(fixture.commands.length, 0);
  } finally { await fixture.cleanup(); }
});

test("RPC ask opens every question at once, leaves a cancelled one unanswered, and changes answers from the review", async () => {
  const fixture = askFixture();
  const pending: Array<{ title: string; choices: string[]; answer: (choice: string | undefined) => void }> = [];
  const waiting: Array<() => void> = [];
  const nextDialog = async () => {
    while (pending.length === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    return pending.shift()!;
  };
  const ui = {
    select: (title: string, choices: string[]) => new Promise<string | undefined>((answer) => {
      pending.push({ title, choices, answer });
      waiting.splice(0).forEach((wake) => wake());
    }),
  };
  try {
    const result = fixture.execute("parallel", {
      questions: [
        { id: "first", question: "First?", options: [{ label: "Same" }, { label: "Same" }] },
        { id: "second", question: "Second?", options: [{ label: "Y" }, { label: "Z" }], allowOther: false },
      ],
    }, undefined, undefined, { hasUI: true, mode: "rpc", ui });

    const first = await nextDialog();
    const second = await nextDialog();
    assert.deepEqual([first.title, second.title], ["(1/2) First?", "(2/2) Second?"], "both questions ask at once");
    assert.deepEqual(first.choices.slice(0, 2), ["Same", "Same (2)"], "duplicate labels stay distinct");
    second.answer("Y");
    first.answer(undefined);

    let review = await nextDialog();
    assert.equal(review.title, "Review your answers");
    assert.deepEqual(review.choices, ["Submit answers", "Change: First? → (unanswered)", "Change: Second? → Y"]);
    review.answer("Change: Second? → Y");
    const change = await nextDialog();
    assert.equal(change.title, "(2/2) Second?");
    assert.deepEqual(change.choices.slice(0, 3), ["Keep current answer: Y", "Y (Current)", "Z"]);
    change.answer("Z");

    review = await nextDialog();
    assert.deepEqual(review.choices, ["Submit answers", "Change: First? → (unanswered)", "Change: Second? → Z"]);
    review.answer("Submit answers");
    const answered = await result;
    assert.equal(answered.details.cancelled, false);
    assert.deepEqual(answered.details.results.map((entry) => entry.selectedOptions), [[], ["Z"]]);
    assert.equal(answered.content[0].text, "User answers:\nfirst: (unanswered)\nsecond: Z");
    assert.equal(pending.length, 0, "no dialog stays open");

    const cancelled = fixture.execute("review-cancel", { questions: [questions[0], { ...questions[0], id: "other" }] }, undefined, undefined, { hasUI: true, mode: "rpc", ui });
    (await nextDialog()).answer(undefined);
    (await nextDialog()).answer(undefined);
    (await nextDialog()).answer(undefined);
    assert.equal((await cancelled).details.cancelled, true, "cancelling the review cancels the ask");
  } finally { await fixture.cleanup(); }
});

test("TUI form stacks every question, scrolls to the focus, edits, clears, and submits unanswered questions", async () => {
  const fixture = askFixture();
  try {
    const many = Array.from({ length: 6 }, (_entry, index) => ({
      id: `q${index + 1}`, question: `Question number ${index + 1}?`, options: [{ label: "Yes" }, { label: "No", description: "decline" }],
    }));
    const form = openForm(fixture, { questions: many }, 20);
    assert.deepEqual(form.blocked(), { kind: "question", message: "Answer 6 questions" });
    let lines = form.render();
    assert.ok(lines.length <= 14, `the form fits the viewport: ${lines.length} lines`);
    assert.ok(lines.some((line) => line.includes("(1/6) Question number 1?")));
    assert.ok(lines.some((line) => line.includes("lines 1–")), "the form reports its scroll position");

    // Answering a single-choice question moves on to the next one.
    form.press(KEY.enter);
    lines = form.render();
    assert.ok(lines.some((line) => line.includes("→ ( ) Yes")) && lines.some((line) => line.includes("(2/6) Question number 2?")));

    // Tab jumps to the last question, which scrolls into view with its heading.
    form.press(KEY.tab, KEY.tab, KEY.tab, KEY.tab);
    lines = form.render();
    assert.ok(lines.some((line) => line.includes("(6/6) Question number 6?")));
    assert.ok(!lines.some((line) => line.includes("(1/6)")), "earlier questions scrolled away");

    // Edit "No" as typed text in the embedded editor.
    form.press(KEY.down, KEY.right);
    lines = form.render();
    assert.ok(lines.some((line) => line.includes("save")));
    assert.ok(lines.some((line) => line.includes("(6/6) Question number 6?")), "the editor keeps its question in view");
    for (const character of " thanks") form.press(character);
    form.press(KEY.enter);
    lines = form.render();
    assert.ok(lines.some((line) => line.includes("Answer: No thanks")));
    assert.ok(lines.some((line) => line.includes("→ Submit answers (2/6 answered)")), "the last answer moves to Submit");

    // Clear the first answer from the first question, then submit with unanswered questions.
    form.press(KEY.tab, KEY.delete, KEY.shiftTab, KEY.enter);
    const result = await form.result;
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(result.details.results.map((entry) => entry.customInput ?? entry.selectedOptions[0] ?? null), [null, null, null, null, null, "No thanks"]);
    assert.match(result.content[0].text, /^User answers:\nq1: \(unanswered\)\n/);
  } finally { await fixture.cleanup(); }
});

test("TUI form toggles multi-choice answers, submits a lone single choice, and cancels with escape", async () => {
  const fixture = askFixture();
  try {
    const multi = openForm(fixture, { questions: [questions[0], { id: "lone", question: "Pick", options: [{ label: "X" }] }] });
    multi.press(KEY.enter, KEY.down, KEY.enter, KEY.up, KEY.enter);
    assert.ok(multi.render().some((line) => line.includes("Answer: [B]")));
    multi.press(KEY.escape);
    assert.equal((await multi.result).details.cancelled, true);

    const lone = openForm(fixture, { questions: [{ ...questions[0], multi: false }] });
    lone.press(KEY.down, KEY.enter);
    const result = await lone.result;
    assert.deepEqual(result.details.results[0].selectedOptions, ["B"]);
  } finally { await fixture.cleanup(); }
});

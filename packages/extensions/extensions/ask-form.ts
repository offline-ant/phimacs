// The TUI form of `ask`: every question stacked in one scrolling form, answered in any order, then submitted.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type KeybindingDefinitions,
	KeybindingsManager,
	type Keybinding,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	answerPreview,
	type AskForkLauncher,
	type AskQuestion,
	discussInFork,
	FORK_OPTION,
	isAnswered,
	optionDisplay,
	OTHER_OPTION,
	previewText,
	type QuestionResult,
	unansweredResult,
} from "./ask-question.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"ask.nextQuestion": true;
		"ask.previousQuestion": true;
		"ask.edit": true;
		"ask.clear": true;
	}
}

/**
 * Asks QUESTIONS in one TUI form and returns their results, or undefined when
 * the ask was cancelled. Questions are answered in any order and stay
 * changeable until Submit; unanswered questions may be submitted. A lone
 * single-choice question submits with its answer.
 */
export async function askWithForm(
	questions: AskQuestion[],
	launchFork: AskForkLauncher,
	ctx: ExtensionContext,
): Promise<QuestionResult[] | undefined> {
	const message = questions.length === 1 ? questions[0].question : `Answer ${questions.length} questions`;
	const results = await ctx.ui.custom<QuestionResult[] | undefined>(
		(tui, theme, keybindings, done) => new AskForm(
			questions,
			launchFork,
			{ tui, theme, keys: new KeybindingsManager(ASK_FORM_KEYBINDINGS, keybindings.getUserBindings()), done },
			ctx,
		),
		{ blocked: { kind: "question", message } },
	);
	return ctx.signal?.aborted ? undefined : results;
}

const ASK_FORM_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"ask.nextQuestion": { defaultKeys: "tab", description: "Go to the next question" },
	"ask.previousQuestion": { defaultKeys: "shift+tab", description: "Go to the previous question" },
	"ask.edit": { defaultKeys: ["right", "ctrl+e"], description: "Edit the selected option as a typed answer" },
	"ask.clear": { defaultKeys: ["delete", "backspace"], description: "Clear the answer of the question" },
} as const satisfies KeybindingDefinitions;

/** Share of the terminal height the form may take; taller forms scroll. */
const VIEWPORT_SHARE = 0.7;

type FormRow =
	| { kind: "option"; question: number; option: number }
	| { kind: "other"; question: number }
	| { kind: "fork"; question: number }
	| { kind: "submit" };

type QuestionRow = Exclude<FormRow, { kind: "submit" }>;

interface FormHost {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	done: (results: QuestionResult[] | undefined) => void;
}

interface Edit {
	row: QuestionRow;
	editor: Editor;
}

class AskForm implements Component {
	private readonly questions: AskQuestion[];
	private readonly launchFork: AskForkLauncher;
	private readonly host: FormHost;
	private readonly ctx: ExtensionContext;
	private readonly rows: FormRow[] = [];
	private readonly results: QuestionResult[];
	private readonly forkDrafts: Array<string | undefined>;
	private focus = 0;
	private scrollTop = 0;
	private edit: Edit | undefined;
	private forking = false;
	private readonly onAbort = (): void => this.host.done(undefined);

	constructor(
		questions: AskQuestion[],
		launchFork: AskForkLauncher,
		host: FormHost,
		ctx: ExtensionContext,
	) {
		this.questions = questions;
		this.launchFork = launchFork;
		this.host = host;
		this.ctx = ctx;
		questions.forEach((question, index) => {
			question.options.forEach((_option, option) => this.rows.push({ kind: "option", question: index, option }));
			if (question.allowOther !== false) this.rows.push({ kind: "other", question: index });
			this.rows.push({ kind: "fork", question: index });
		});
		this.rows.push({ kind: "submit" });
		this.results = questions.map(unansweredResult);
		this.forkDrafts = questions.map(() => undefined);
		ctx.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	handleInput(data: string): void {
		if (this.forking) return;
		if (this.edit) this.handleEditInput(this.edit, data);
		else this.handleFormInput(data);
		this.host.tui.requestRender();
	}

	invalidate(): void {
		this.edit?.editor.invalidate();
	}

	dispose(): void {
		this.ctx.signal?.removeEventListener("abort", this.onAbort);
	}

	render(width: number): string[] {
		const body: string[] = [];
		let focusStart = 0;
		let contextStart = 0;
		let focusEnd = 0;
		let question = -1;
		this.rows.forEach((row, index) => {
			if (row.kind !== "submit" && row.question !== question) {
				question = row.question;
				if (question > 0) body.push("");
				if (index <= this.focus) contextStart = body.length;
				body.push(...this.renderHeading(question, width));
			}
			if (row.kind === "submit") {
				body.push("");
				if (index <= this.focus) contextStart = body.length;
			}
			if (index === this.focus) focusStart = body.length;
			body.push(...this.renderRow(row, index === this.focus, width));
			if (this.edit?.row === row) {
				body.push(...this.edit.editor.render(Math.max(1, width - 6)).map((line) => `      ${line}`));
			}
			if (index === this.focus) focusEnd = body.length;
		});

		const theme = this.host.theme;
		const hint = wrapPrefixed(" ", theme.fg("dim", this.hint()), width);
		const budget = Math.max(4, Math.floor(this.host.tui.terminal.rows * VIEWPORT_SHARE)) - hint.length;
		if (body.length <= budget) {
			this.scrollTop = 0;
			return [...body, ...hint];
		}
		// One line of the budget shows the scroll position.
		const height = Math.max(1, budget - 1);
		// Show the focused row with its question heading when both fit, else the focused row,
		// from its top when it is taller than the viewport.
		const start = focusEnd - contextStart <= height ? contextStart : focusStart;
		if (start < this.scrollTop) this.scrollTop = start;
		if (focusEnd > this.scrollTop + height) this.scrollTop = Math.min(focusEnd - height, start);
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, body.length - height));
		const end = Math.min(body.length, this.scrollTop + height);
		const position = theme.fg("dim", `lines ${this.scrollTop + 1}–${end} of ${body.length}`);
		return [...body.slice(this.scrollTop, end), ...wrapPrefixed(" ", position, width).slice(0, 1), ...hint];
	}

	private handleFormInput(data: string): void {
		const keys = this.host.keys;
		const row = this.rows[this.focus];
		if (keys.matches(data, "tui.select.up")) this.focus = (this.focus + this.rows.length - 1) % this.rows.length;
		else if (keys.matches(data, "tui.select.down")) this.focus = (this.focus + 1) % this.rows.length;
		else if (keys.matches(data, "ask.nextQuestion")) this.focusQuestion(this.questionOf(row) + 1);
		else if (keys.matches(data, "ask.previousQuestion")) this.focusQuestion(this.questionOf(row) - 1);
		else if (keys.matches(data, "tui.select.confirm")) this.activate(row);
		else if (keys.matches(data, "ask.edit") && (row.kind === "option" || row.kind === "other")) this.startEdit(row);
		else if (keys.matches(data, "ask.clear") && row.kind !== "submit") {
			this.results[row.question] = unansweredResult(this.questions[row.question]);
		} else if (keys.matches(data, "tui.select.cancel")) this.host.done(undefined);
	}

	private handleEditInput(edit: Edit, data: string): void {
		if (this.host.keys.matches(data, "tui.select.cancel")) this.edit = undefined;
		else edit.editor.handleInput(data);
	}

	/** Returns the question index of ROW; the Submit row counts as one past the last question. */
	private questionOf(row: FormRow): number {
		return row.kind === "submit" ? this.questions.length : row.question;
	}

	/** Focuses the first row of QUESTION, where one past the last question is the Submit row; wraps around. */
	private focusQuestion(question: number): void {
		const stops = this.questions.length + 1;
		const target = (question + stops) % stops;
		this.focus = this.rows.findIndex((row) => this.questionOf(row) === target);
	}

	private activate(row: FormRow): void {
		switch (row.kind) {
			case "submit":
				this.host.done(this.results);
				return;
			case "other":
				this.startEdit(row);
				return;
			case "fork":
				void this.fork(row.question);
				return;
			case "option": {
				const question = this.questions[row.question];
				const label = question.options[row.option].label;
				if (!question.multi) {
					this.answer(row.question, { ...unansweredResult(question), selectedOptions: [label] });
					return;
				}
				const current = this.results[row.question];
				const selected = current.selectedOptions.includes(label)
					? current.selectedOptions.filter((entry) => entry !== label)
					: [...current.selectedOptions, label];
				this.results[row.question] = {
					...current,
					selectedOptions: question.options.map((option) => option.label).filter((entry) => selected.includes(entry)),
				};
			}
		}
	}

	private startEdit(row: Extract<FormRow, { kind: "option" | "other" }>): void {
		const theme = this.host.theme;
		const editor = new Editor(this.host.tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		editor.setText(row.kind === "option"
			? this.questions[row.question].options[row.option].label
			: this.results[row.question].customInput ?? "");
		editor.onSubmit = (text) => this.applyEdit(row, text);
		this.edit = { row, editor };
	}

	private applyEdit(row: Extract<FormRow, { kind: "option" | "other" }>, text: string): void {
		this.edit = undefined;
		const question = this.questions[row.question];
		if (!question.multi) {
			this.answer(row.question, { ...unansweredResult(question), customInput: text });
			return;
		}
		const current = this.results[row.question];
		const edited = row.kind === "option" ? question.options[row.option].label : undefined;
		this.results[row.question] = {
			...current,
			selectedOptions: current.selectedOptions.filter((label) => label !== edited),
			customInput: text,
		};
	}

	/** Records the answer of a single-choice question and moves on to the next question, or submits a lone one. */
	private answer(question: number, result: QuestionResult): void {
		this.results[question] = result;
		if (this.questions.length === 1) this.host.done(this.results);
		else this.focusQuestion(question + 1);
	}

	/** Edits a discussion prompt in a dialog above the form and launches a fork; the form keeps its state. */
	private async fork(question: number): Promise<void> {
		this.forking = true;
		try {
			this.forkDrafts[question] = await discussInFork(
				this.questions[question],
				this.results[question],
				this.launchFork,
				this.forkDrafts[question],
				this.ctx,
			);
		} finally {
			this.forking = false;
			this.host.tui.requestRender();
		}
	}

	private renderHeading(question: number, width: number): string[] {
		const theme = this.host.theme;
		const result = this.results[question];
		const marker = isAnswered(result) ? theme.fg("success", "✓ ") : theme.fg("warning", "○ ");
		const heading = theme.fg("accent", theme.bold(`(${question + 1}/${this.questions.length}) ${this.questions[question].question}`));
		const answer = isAnswered(result)
			? theme.fg("muted", `Answer: ${answerPreview(result)}`)
			: theme.fg("warning", `Answer: ${answerPreview(result)}`);
		return [...wrapPrefixed(marker, heading, width), ...wrapPrefixed("    ", answer, width)];
	}

	private renderRow(row: FormRow, focused: boolean, width: number): string[] {
		const theme = this.host.theme;
		const text = this.rowText(row);
		const prefix = row.kind === "submit" ? (focused ? "→ " : "  ") : (focused ? "  → " : "    ");
		const lines = wrapPrefixed(prefix, text, width);
		if (focused) return lines.map((line) => theme.fg("accent", line));
		return row.kind === "fork" ? lines.map((line) => theme.fg("dim", line)) : lines;
	}

	private rowText(row: FormRow): string {
		if (row.kind === "submit") {
			const answered = this.results.filter(isAnswered).length;
			return `Submit answers (${answered}/${this.questions.length} answered)`;
		}
		const question = this.questions[row.question];
		const result = this.results[row.question];
		const marker = (selected: boolean): string => question.multi
			? (selected ? "[x] " : "[ ] ")
			: (selected ? "(•) " : "( ) ");
		switch (row.kind) {
			case "option":
				return `${marker(result.selectedOptions.includes(question.options[row.option].label))}${optionDisplay(question, row.option)}`;
			case "other":
				return result.customInput === undefined
					? `${marker(false)}${OTHER_OPTION}`
					: `${marker(true)}Other: ${previewText(result.customInput) || "(empty)"}`;
			case "fork":
				return this.forking ? `    ${FORK_OPTION}…` : `    ${FORK_OPTION}`;
		}
	}

	private hint(): string {
		const keys = (binding: Keybinding): string => this.host.keys.getKeys(binding).join("/") || "unbound";
		const parts = this.edit
			? [`${keys("tui.input.submit")} save`, `${keys("tui.input.newLine")} new line`, `${keys("tui.select.cancel")} stop editing`]
			: [
				`${keys("tui.select.up")}/${keys("tui.select.down")} move`,
				`${keys("ask.nextQuestion")}/${keys("ask.previousQuestion")} question`,
				`${keys("tui.select.confirm")} select`,
				`${keys("ask.edit")} edit`,
				`${keys("ask.clear")} clear`,
				`${keys("tui.select.cancel")} cancel`,
			];
		return parts.join("  ");
	}
}

/** Wraps TEXT to WIDTH with PREFIX on the first line and its width of spaces on the others. */
function wrapPrefixed(prefix: string, text: string, width: number): string[] {
	const prefixWidth = visibleWidth(prefix);
	const continuation = " ".repeat(prefixWidth);
	return wrapTextWithAnsi(text, Math.max(1, width - prefixWidth))
		.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

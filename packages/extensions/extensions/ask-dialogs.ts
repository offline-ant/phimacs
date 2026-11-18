// Standard dialogs of `ask` (RPC frontends such as Emacs): every question asks at once, then one review settles them.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type ChoiceValue =
	| { kind: "keep" }
	| { kind: "option"; label: string }
	| { kind: "done" }
	| { kind: "other" }
	| { kind: "fork" };

interface Choice {
	label: string;
	value: ChoiceValue;
	editPrefill?: string;
}

type PickResult =
	| { action: "selected"; choice: Choice }
	| { action: "edit"; choice: Choice }
	| { action: "cancel" };

const DONE_OPTION = "Done selecting";
const EDIT_OPTION = "Edit an option as your answer…";
const EDIT_TITLE = "Edit which option?";
const CURRENT_SUFFIX = " (Current)";
const REVIEW_TITLE = "Review your answers";
const SUBMIT_OPTION = "Submit answers";

/**
 * Asks QUESTIONS in standard dialogs and returns their results, or undefined
 * when the ask was cancelled. All questions ask at once and are answered in
 * any order; cancelling one leaves it unanswered. Once every question dialog
 * has settled, a review dialog submits the answers or changes one of them.
 * A lone question is the whole ask: its answer submits, its cancellation cancels.
 * Pi does not tell frontends about dialogs it settles itself, so no dialog of
 * this ask stays open when it returns.
 */
export async function askWithDialogs(
	questions: AskQuestion[],
	launchFork: AskForkLauncher,
	ctx: ExtensionContext,
): Promise<QuestionResult[] | undefined> {
	const ask = async (index: number, current: QuestionResult): Promise<QuestionResult | undefined> => {
		const question = questions[index];
		const title = `(${index + 1}/${questions.length}) ${question.question}`;
		const previous = isAnswered(current) ? current : undefined;
		return question.multi
			? askMultiChoice(question, title, previous, launchFork, ctx)
			: askSingleChoice(question, title, previous, launchFork, ctx);
	};
	const results = questions.map(unansweredResult);
	if (questions.length === 1) {
		const result = await ask(0, results[0]);
		return result && !ctx.signal?.aborted ? [result] : undefined;
	}
	await Promise.all(results.map(async (result, index) => {
		results[index] = (await ask(index, result)) ?? result;
	}));
	while (!ctx.signal?.aborted) {
		const selected = await selectLabeled(REVIEW_TITLE, [
			{ label: SUBMIT_OPTION, value: -1 },
			...results.map((result, index) => ({
				label: `Change: ${previewText(questions[index].question)} → ${answerPreview(result)}`,
				value: index,
			})),
		], ctx);
		if (selected === undefined) return undefined;
		if (selected < 0) return results;
		results[selected] = (await ask(selected, results[selected])) ?? unansweredResult(questions[selected]);
	}
	return undefined;
}

async function askSingleChoice(
	question: AskQuestion,
	title: string,
	previous: QuestionResult | undefined,
	launchFork: AskForkLauncher,
	ctx: ExtensionContext,
): Promise<QuestionResult | undefined> {
	const customInput = previous?.customInput;
	let forkDraft: string | undefined;
	while (true) {
		const choices: Choice[] = [];
		if (previous) choices.push(keepChoice(previous));
		question.options.forEach((option, index) => {
			const current = customInput === undefined && previous?.selectedOptions.includes(option.label);
			choices.push({
				label: `${optionDisplay(question, index)}${current ? CURRENT_SUFFIX : ""}`,
				value: { kind: "option", label: option.label },
				editPrefill: option.label,
			});
		});
		if (question.allowOther !== false) {
			choices.push({
				label: customInput === undefined ? OTHER_OPTION : `${OTHER_OPTION} — Current: ${previewText(customInput) || "(empty)"}`,
				value: { kind: "other" },
				editPrefill: customInput ?? "",
			});
		}
		choices.push({ label: FORK_OPTION, value: { kind: "fork" } });

		const picked = await pickChoice(title, choices, ctx);
		if (picked.action === "cancel") return undefined;
		if (picked.action === "edit") {
			const input = await ctx.ui.editor("Edit selected answer", picked.choice.editPrefill);
			if (input === undefined) continue;
			return { ...unansweredResult(question), customInput: input };
		}
		switch (picked.choice.value.kind) {
			case "keep":
				return previous;
			case "fork":
				forkDraft = await discussInFork(question, previous ?? unansweredResult(question), launchFork, forkDraft, ctx);
				continue;
			case "other": {
				const input = await ctx.ui.editor("Enter your response", customInput);
				if (input === undefined) continue;
				return { ...unansweredResult(question), customInput: input };
			}
			case "option":
				return { ...unansweredResult(question), selectedOptions: [picked.choice.value.label] };
		}
	}
}

async function askMultiChoice(
	question: AskQuestion,
	title: string,
	previous: QuestionResult | undefined,
	launchFork: AskForkLauncher,
	ctx: ExtensionContext,
): Promise<QuestionResult | undefined> {
	const selected = new Set(previous?.selectedOptions);
	let customInput = previous?.customInput;
	let forkDraft: string | undefined;
	const current = (): QuestionResult => ({
		...unansweredResult(question),
		selectedOptions: question.options.map((option) => option.label).filter((label) => selected.has(label)),
		...(customInput === undefined ? {} : { customInput }),
	});
	while (true) {
		const choices: Choice[] = [];
		if (previous) choices.push(keepChoice(previous));
		question.options.forEach((option, index) => {
			choices.push({
				label: `${selected.has(option.label) ? "[x]" : "[ ]"} ${optionDisplay(question, index)}`,
				value: { kind: "option", label: option.label },
				editPrefill: option.label,
			});
		});
		if (selected.size > 0 || customInput !== undefined) {
			choices.push({ label: DONE_OPTION, value: { kind: "done" } });
		}
		if (question.allowOther !== false) {
			choices.push({ label: OTHER_OPTION, value: { kind: "other" }, editPrefill: customInput ?? "" });
		}
		choices.push({ label: FORK_OPTION, value: { kind: "fork" } });

		const picked = await pickChoice(title, choices, ctx);
		if (picked.action === "cancel") return undefined;
		if (picked.action === "edit") {
			const input = await ctx.ui.editor("Edit selected answer", picked.choice.editPrefill);
			if (input === undefined) continue;
			customInput = input;
			if (picked.choice.value.kind === "option") selected.delete(picked.choice.value.label);
			return current();
		}
		switch (picked.choice.value.kind) {
			case "keep":
				return previous;
			case "done":
				return current();
			case "fork":
				forkDraft = await discussInFork(question, current(), launchFork, forkDraft, ctx);
				continue;
			case "other": {
				const input = await ctx.ui.editor("Enter your response", customInput);
				if (input === undefined) continue;
				customInput = input;
				return current();
			}
			case "option":
				if (!selected.delete(picked.choice.value.label)) selected.add(picked.choice.value.label);
				continue;
		}
	}
}

function keepChoice(previous: QuestionResult): Choice {
	return { label: `Keep current answer: ${answerPreview(previous)}`, value: { kind: "keep" } };
}

/**
 * Standard select dialogs have no edit key: one extra entry before the fork
 * entry picks the option to edit, instead of one entry per option.
 */
async function pickChoice(title: string, choices: Choice[], ctx: ExtensionContext): Promise<PickResult> {
	const editable = choices.filter((choice) => choice.value.kind === "option");
	const entries: Array<{ label: string; value: Choice | "edit" }> = choices.map((choice) => ({
		label: choice.label,
		value: choice,
	}));
	const forkIndex = choices.findIndex((choice) => choice.value.kind === "fork");
	entries.splice(forkIndex, 0, { label: EDIT_OPTION, value: "edit" });
	while (true) {
		const selected = await selectLabeled(title, entries, ctx);
		if (selected === undefined) return { action: "cancel" };
		if (selected !== "edit") return { action: "selected", choice: selected };
		const choice = await selectLabeled(
			EDIT_TITLE,
			editable.map((option) => ({ label: option.label, value: option })),
			ctx,
		);
		if (ctx.signal?.aborted) return { action: "cancel" };
		if (choice) return { action: "edit", choice };
	}
}

/** Selects one of ENTRIES by label; repeated labels get a counter, since the label identifies the answer. */
async function selectLabeled<T>(
	title: string,
	entries: Array<{ label: string; value: T }>,
	ctx: ExtensionContext,
): Promise<T | undefined> {
	const counts = new Map<string, number>();
	const labels = entries.map(({ label }) => {
		const count = (counts.get(label) ?? 0) + 1;
		counts.set(label, count);
		return count === 1 ? label : `${label} (${count})`;
	});
	const selected = await ctx.ui.select(title, labels, { signal: ctx.signal });
	if (ctx.signal?.aborted || selected === undefined) return undefined;
	return entries[labels.indexOf(selected)]?.value;
}

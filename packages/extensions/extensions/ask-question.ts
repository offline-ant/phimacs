// Questions, answers and their text forms, shared by the TUI form and the standard dialogs of `ask`.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ForkResult } from "@phimacs/orchestration/fork-here";

const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
	description: Type.Optional(
		Type.String({ description: "Optional description of this option" }),
	),
});

const AskQuestionSchema = Type.Object({
	id: Type.Optional(
		Type.String({ description: "Stable id for this question" }),
	),
	question: Type.String({ description: "Question text to show the user" }),
	options: Type.Array(AskOptionSchema, {
		description: "Available options",
		minItems: 1,
	}),
	multi: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options" }),
	),
	recommended: Type.Optional(
		Type.Number({ description: "Zero-based recommended option index" }),
	),
	allowOther: Type.Optional(
		Type.Boolean({
			description: "Allow free-form user input. Defaults to true.",
		}),
	),
});

export const AskParamsSchema = Type.Object({
	questions: Type.Array(AskQuestionSchema, {
		description: "Questions to ask the user",
		minItems: 1,
	}),
});

export type AskParams = Static<typeof AskParamsSchema>;

/** A question whose id is always set. */
export type AskQuestion = AskParams["questions"][number] & { id: string };

/** The answer to one question; no selection and no custom input means unanswered. */
export interface QuestionResult {
	id: string;
	question: string;
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

export type AskForkLauncher = (prompt: string) => Promise<ForkResult>;

export const OTHER_OPTION = "Other (type your own)";
export const FORK_OPTION = "Fork (discuss separately)";
export const UNANSWERED = "(unanswered)";
const RECOMMENDED_SUFFIX = " (Recommended)";

/** Returns the unanswered result of QUESTION. */
export function unansweredResult(question: AskQuestion): QuestionResult {
	return {
		id: question.id,
		question: question.question,
		multi: question.multi === true,
		selectedOptions: [],
	};
}

/** Returns whether RESULT holds an answer. */
export function isAnswered(result: QuestionResult): boolean {
	return result.selectedOptions.length > 0 || result.customInput !== undefined;
}

/** Returns the display text of OPTION of QUESTION, with its description and recommendation. */
export function optionDisplay(question: AskQuestion, index: number): string {
	const option = question.options[index];
	const base = option.description
		? `${option.label} — ${option.description}`
		: option.label;
	return index === question.recommended ? `${base}${RECOMMENDED_SUFFIX}` : base;
}

/** Returns TEXT on one line, shortened to 60 characters. */
export function previewText(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 60) return collapsed;
	return `${collapsed.slice(0, 57)}...`;
}

/** Returns a short one-line form of RESULT. */
export function answerPreview(result: QuestionResult): string {
	if (!isAnswered(result)) return UNANSWERED;
	const answers = [...result.selectedOptions];
	if (result.customInput !== undefined) {
		answers.push(previewText(result.customInput) || "(empty)");
	}
	return result.multi ? `[${answers.join(", ")}]` : answers[0];
}

/** Returns RESULT as the tool reports it to the model. */
export function formatResult(result: QuestionResult): string {
	if (!isAnswered(result)) return `${result.id}: ${UNANSWERED}`;
	const answers = [...result.selectedOptions];
	if (result.customInput !== undefined) answers.push(result.customInput);
	return result.multi
		? `${result.id}: [${answers.join(", ")}]`
		: `${result.id}: ${answers[0]}`;
}

/** Returns the default prompt of a discussion fork about QUESTION. */
function forkDiscussionPrompt(question: AskQuestion, current: QuestionResult): string {
	const lines = [
		"First talk through the current situation and relevant context with me. Then help me think through this question before I answer it in the parent session. Explore the tradeoffs and ask clarifying questions as needed.",
		"",
		question.question,
		"",
		"Options:",
		...question.options.map((option) =>
			option.description
				? `- ${option.label} — ${option.description}`
				: `- ${option.label}`,
		),
	];
	if (isAnswered(current)) lines.push("", `Current answer: ${answerPreview(current)}`);
	return lines.join("\n");
}

/**
 * Edits a discussion prompt about QUESTION and launches a fork with it; the
 * question stays open. Returns the draft to offer next time: the failed or
 * empty input, the earlier DRAFT when the editor was cancelled, or undefined
 * once a fork started.
 */
export async function discussInFork(
	question: AskQuestion,
	current: QuestionResult,
	launchFork: AskForkLauncher,
	draft: string | undefined,
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const input = await ctx.ui.editor(
		"Discuss in a fork",
		draft ?? forkDiscussionPrompt(question, current),
	);
	if (input === undefined) return draft;
	if (input.trim().length === 0) {
		ctx.ui.notify("Enter a question for the fork.", "warning");
		return input;
	}
	try {
		const result = await launchFork(input);
		ctx.ui.notify(
			`Started ${result.name}. Return here to answer when ready.`,
			"info",
		);
		return undefined;
	} catch (error) {
		ctx.ui.notify(
			`Fork failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return input;
	}
}

// The `ask` tool: questions the model asks the user, answered in one TUI form or in parallel standard dialogs.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forkHere } from "@phimacs/orchestration/fork-here";
import {
	getPreToolCallLeafId,
	modelCliArgs,
} from "@phimacs/orchestration/context";
import { askWithDialogs } from "./ask-dialogs.ts";
import { askWithForm } from "./ask-form.ts";
import {
	type AskForkLauncher,
	AskParamsSchema,
	formatResult,
	type QuestionResult,
} from "./ask-question.ts";

interface AskDetails {
	results: QuestionResult[];
	cancelled: boolean;
}

export default function askExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		// Questions belong to the model's own tool call: its transcript position anchors discussion forks.
		exposure: "model-only",
		description:
			"Ask the user interactive multiple-choice or free-form questions when a required preference, approval, or decision is missing. Returns answers keyed by question id; unanswered questions, cancellation and non-interactive use are reported explicitly.",
		parameters: AskParamsSchema,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "Ask tool requires interactive mode." }],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}

			const launchFork: AskForkLauncher = async (prompt) => {
				const branchFromId = getPreToolCallLeafId(ctx.sessionManager, "ask", toolCallId);
				return forkHere(
					pi,
					{ prompt },
					ctx.cwd,
					ctx.sessionManager,
					modelCliArgs(ctx.model, pi.getThinkingLevel()),
					signal,
					branchFromId,
				);
			};
			const questions = params.questions.map((question, index) => ({
				...question,
				id: question.id ?? `question_${index + 1}`,
			}));
			const results = ctx.mode === "tui"
				? await askWithForm(questions, launchFork, ctx)
				: await askWithDialogs(questions, launchFork, ctx);
			if (!results) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the ask dialog." }],
					details: { results: [], cancelled: true } satisfies AskDetails,
				};
			}
			return {
				content: [{ type: "text" as const, text: `User answers:\n${results.map(formatResult).join("\n")}` }],
				details: { results, cancelled: false } satisfies AskDetails,
			};
		},
	});
}

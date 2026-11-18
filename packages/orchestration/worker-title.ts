import { stripVTControlCharacters } from "node:util";

// Fixed display vocabulary selected from historical task openings, not runtime statistics.
// Fillers repeat what the worker tree already shows or only add emphasis; qualifiers describe the work and stay visible.
const fillers = new Set(["only", "separate", "distinct", "new", "subtask", "genuinely", "actual", "actually",
  "independently", "agreed", "a", "the"]);
const qualifiers = new Set(["read-only", "independent", "final", "fresh-eyes", "fresh", "focused",
  "narrow", "critical", "critically", "adversarial", "second", "small", "quick"]);
const actions = new Map([["review", "☀️"], ["implement", "🔨"], ["build", "🔨"], ["investigate", "🔍"],
  ["verify", "⚖️"]]);

/** A short display title, never a worker's operational/recovery identity. */
export function workerTitle(task: string): string {
  const sentences = stripVTControlCharacters(task).replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/(?<![\p{L}\p{N}_/\\])(\*{1,2})([^*]+)\1(?![\p{L}\p{N}_.])/gu, "$2")
      .replace(/(?<![\p{L}\p{N}_/\\])(_{1,2})([^_]+)\1(?![\p{L}\p{N}_.])/gu, "$2")
      .replace(/(?<![\p{L}\p{N}_/\\])(~{1,2})([^~]+)\1(?![\p{L}\p{N}_.])/gu, "$2")
      .trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^(`{3,}|~{3,})/.test(line))
    // Sentence punctuation must be followed by whitespace/end, not a filename suffix.
    .flatMap((line) => line.split(/[.!?]+(?=\s|$)/).map((sentence) => sentence.trim()))
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  // "Your run was cancelled…" addresses a worker's history; the following sentence states the task.
  const excerpt = (sentences.find((sentence) => !/^your\b/i.test(sentence)) ?? sentences[0] ?? "")
    .replace(/^you are (?:(?:a|an|the|next|one of \S+)\s+)*/i, "")
    .replace(/^you own\b/i, "Own")
    // The worker tree shows the parent a subtask belongs to.
    .replace(/^((?:[\p{L}\p{N}-]+,?\s+){0,3}?)subtask\b(?:\s+of\b[^:]{0,80})?:\s*/iu, "$1");
  const tokens = excerpt.split(/\s+/).filter(Boolean).map((token) => {
    const [, prefix, word, suffix] = /^([("'\[{]*)(.*?)([)"'\]},;:!?]*)$/.exec(token)!;
    const filename = word.split(/[/\\]/).filter(Boolean).at(-1) ?? word;
    // Slash-separated concepts (do/delegate, request/response) are not paths.
    const filesystemPath = /[/\\]/.test(word) && !/^[a-z][a-z\d+.-]*:\/\//i.test(word)
      && (/^(?:[a-z]:)?[/\\]|^(?:\.{1,2}|~)[/\\]/i.test(word) || /\.[\p{L}\p{N}_,+-]+$/u.test(filename));
    const key = filesystemPath ? "" : word.toLowerCase();
    return { text: filesystemPath ? prefix + filename + suffix : token, key, filler: fillers.has(key) };
  });
  const filtered = tokens.filter((token) => !token.filler);
  const words = filtered.length ? filtered : tokens;
  // Leading qualifiers ("Independently review", "Final fresh-eyes review") stay visible after the prefix.
  let start = 0;
  while (start < 3 && qualifiers.has(words[start]?.key ?? "")) start++;
  const action = (index: number) => actions.get(words[index]?.text.replace(/:$/, "").toLowerCase() ?? "");
  const first = words[start]?.key ? action(start) : undefined;
  const second = words[start + 2]?.key ? action(start + 2) : undefined;
  const combined = first && second && words[start + 1].key && /^(?:and|&)$/.test(words[start + 1].key);
  let rest = start + (combined ? 3 : 1);
  if (first && /^(?:of|for)$/.test(words[rest]?.key ?? "")) rest++;
  const title = (first
    ? [`${first}${combined ? second : ""}`, ...words.slice(0, start).map((token) => token.text.toLowerCase()),
      ...words.slice(rest).map((token) => token.text)]
    : words.map((token) => token.text)).join(" ") || "Worker";
  const characters = Array.from(title);
  if (characters.length <= 60) return title;
  let shortened = characters.slice(0, 59).join("");
  const boundary = shortened.lastIndexOf(" ");
  if (boundary > 0) shortened = shortened.slice(0, boundary);
  return `${shortened}…`;
}

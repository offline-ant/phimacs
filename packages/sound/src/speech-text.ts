/** Turn assistant Markdown into speakable prose and split it for speech requests. */

/** Drop code blocks, images, tables' rules and markup; keep link text and paragraph breaks. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(/<[^>\n]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^ {0,3}>\s?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, '$1')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[^\n]*?\S)?)\1/g, '$2')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Greedy chunks of whole sentences, each at most `max` characters; overlong runs split at spaces. */
export function splitSpeechText(text: string, max: number): string[] {
  if (!Number.isInteger(max) || max < 1) throw new Error('Speech chunk size must be a positive integer.');
  // Punctuation followed directly by text (3.14, e.g.x) stays inside the sentence.
  const sentences = text.match(/(?:[^.!?\n]|[.!?]+(?=[^\s"')\]]))+(?:[.!?]+["')\]]*|\n+|$)/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if (current && current.length + 1 + piece.length > max) { chunks.push(current); current = ''; }
    current = current ? `${current} ${piece}` : piece;
  };
  for (const raw of sentences) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (!sentence) continue;
    if (sentence.length <= max) { push(sentence); continue; }
    for (const word of sentence.split(' ')) {
      for (let start = 0; start < word.length; start += max) push(word.slice(start, start + max));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

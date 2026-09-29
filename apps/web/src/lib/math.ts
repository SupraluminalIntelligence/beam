import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { SKIP, visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkMath);
const plainParser = unified().use(remarkParse).use(remarkGfm);
const codeNodes = ["code", "inlineCode", "html", "link", "image", "definition"];
const literalNodes = new Set([...codeNodes, "math", "inlineMath"]);

/** Source ranges of the nodes whose text is literal, in document order. */
function literalRanges(tree: ReturnType<typeof parser.parse>, types: Set<string>) {
  const ranges: [number, number][] = [];
  visit(tree, (node) => {
    if (!types.has(node.type)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
    return SKIP;
  });
  return ranges;
}

const escaped = (text: string, at: number) => { let n = 0; for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) n++; return n % 2 === 1; };

/**
 * remark-math pairs any two dollar runs of the same length, so `for i in $(seq 1 120); do echo $i`, "$5 and $10"
 * or `echo $$; kill $$` turn into equations. Pandoc's rule tells them apart: an opening run has a non-space right
 * after it, a closing run has a non-space right before it and no digit right after it. We also refuse a closer
 * followed by a letter, `{` or `(`, which is how shell variables read. Escape every inline `$` or `$$` that does
 * not pair, so it renders as the literal text it is. Code, links and `$$` fences on their own line are left alone.
 */
export function escapeStrayDollars(text: string): string {
  if (!text.includes("$")) return text;
  const ranges = literalRanges(plainParser.parse(text), new Set(codeNodes));
  const inLiteral = (i: number) => ranges.some(([start, end]) => i >= start && i < end);
  // A `$$` with nothing else before or after it on its line fences display math.
  const fence = (i: number) => /(?:^|\n)[ \t]*$/.test(text.slice(0, i)) || /^[ \t]*(?:\n|$)/.test(text.slice(i + 2));
  const runs = Array.from(text.matchAll(/\$+/g))
    .filter((m) => m[0].length <= 2 && !escaped(text, m.index!) && !inLiteral(m.index!) && !(m[0].length === 2 && fence(m.index!)))
    .map((m) => ({ at: m.index!, size: m[0].length }));
  const opens = ({ at, size }: { at: number; size: number }) => at + size < text.length && !/\s/.test(text[at + size]!);
  // A dollar followed by a name, `{` or `(` starts a shell variable (`$HOME/$USER`), so it never closes math.
  const closes = ({ at, size }: { at: number; size: number }) => !/\s/.test(text[at - 1]!) && !/[\w{(]/.test(text[at + size] ?? "");
  const stray: { at: number; size: number }[] = [];
  let open: { at: number; size: number } | null = null;
  for (const run of runs) {
    if (open) {
      // Only a run of the same length can close; a different one is part of the expression.
      if (run.size !== open.size) continue;
      // Inline math never spans a blank line.
      if (closes(run) && !/\n[ \t]*\n/.test(text.slice(open.at, run.at))) { open = null; continue; }
      stray.push(open); open = null;
    }
    if (opens(run)) open = run; else stray.push(run);
  }
  if (open) stray.push(open);
  let result = "", end = 0;
  for (const { at, size } of stray.sort((a, b) => a.at - b.at)) { result += text.slice(end, at) + "\\$".repeat(size); end = at + size; }
  return result + text.slice(end);
}

/** remark-math understands dollars; also accept the TeX delimiters emitted by agents.
 * Use Markdown source positions to leave code, URLs, and existing math untouched.
 */
export function normalizeMath(input: string): string {
  const text = escapeStrayDollars(input);
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const ranges = literalRanges(parser.parse(text), literalNodes);
  const convert = (source: string) => source.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g, (match: string, inline: string | undefined, display: string | undefined, offset: number) => {
    // A doubled backslash is a literal escape, not a math delimiter.
    let escapes = 0;
    for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) escapes++;
    if (escapes % 2) return match;
    const body = (inline ?? display ?? "").trim();
    if (!body) return match;
    // A longer fence keeps literal dollars inside an expression from closing it.
    const fence = "$".repeat(Math.max(display === undefined ? 1 : 2, ...Array.from(body.matchAll(/\$+/g), m => m[0].length + 1)));
    return display === undefined ? `${fence}${body}${fence}` : `\n\n${fence}\n${body}\n${fence}\n\n`;
  });
  let end = 0, result = "";
  for (const [start, stop] of ranges) {
    result += convert(text.slice(end, start)) + text.slice(start, stop);
    end = stop;
  }
  return result + convert(text.slice(end));
}

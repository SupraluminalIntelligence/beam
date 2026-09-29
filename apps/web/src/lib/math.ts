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
 * remark-math pairs any two single dollars, so `for i in $(seq 1 120); do echo $i` or "$5 and $10" turn into
 * equations. Pandoc's rule tells them apart: an opening `$` has a non-space right after it, a closing `$` has a
 * non-space right before it and no digit right after it. Escape every single dollar that does not pair under
 * that rule, so it renders as the literal dollar it is. Code, links and `$$` fences are left alone.
 */
export function escapeStrayDollars(text: string): string {
  if (!text.includes("$")) return text;
  const ranges = literalRanges(plainParser.parse(text), new Set(codeNodes));
  const inLiteral = (i: number) => ranges.some(([start, end]) => i >= start && i < end);
  const singles = Array.from(text.matchAll(/\$+/g)).filter((m) => m[0].length === 1 && !escaped(text, m.index!) && !inLiteral(m.index!)).map((m) => m.index!);
  const opens = (i: number) => i + 1 < text.length && !/\s/.test(text[i + 1]!);
  const closes = (i: number) => !/\s/.test(text[i - 1]!) && !/\d/.test(text[i + 1] ?? "");
  const stray: number[] = [];
  let open = -1;
  for (const i of singles) {
    if (open >= 0) {
      // Inline math never spans a blank line.
      if (closes(i) && !/\n[ \t]*\n/.test(text.slice(open, i))) { open = -1; continue; }
      stray.push(open); open = -1;
    }
    if (opens(i)) open = i; else stray.push(i);
  }
  if (open >= 0) stray.push(open);
  let result = "", end = 0;
  for (const i of stray) { result += text.slice(end, i) + "\\"; end = i; }
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

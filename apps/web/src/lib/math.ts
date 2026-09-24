import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import { SKIP, visit } from "unist-util-visit";

const parser = unified().use(remarkParse).use(remarkMath);
const literalNodes = new Set(["code", "inlineCode", "html", "link", "image", "definition", "math", "inlineMath"]);

/** remark-math understands dollars; also accept the TeX delimiters emitted by agents.
 * Use Markdown source positions to leave code, URLs, and existing math untouched.
 */
export function normalizeMath(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const ranges: [number, number][] = [];
  visit(parser.parse(text), (node) => {
    if (!literalNodes.has(node.type)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
    return SKIP;
  });
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

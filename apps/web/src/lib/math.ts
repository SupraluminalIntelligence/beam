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
function literalRanges(text: string, tree: ReturnType<typeof parser.parse>, types: Set<string>) {
  const ranges: [number, number][] = [];
  visit(tree, (node) => {
    if (!types.has(node.type)) return;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return SKIP;
    // A `[label](url)` link: only the destination is literal; the label is prose. Autolinks stay whole.
    const label = node.type === "link" && text[start] === "[" && "children" in node ? node.children : [];
    const first = label[0]?.position?.start.offset, last = label.at(-1)?.position?.end.offset;
    if (first === undefined || last === undefined) { ranges.push([start, end]); return SKIP; }
    ranges.push([start, first], [last, end]);
    return undefined;
  });
  return ranges.sort((a, b) => a[0] - b[0]);
}

const escaped = (text: string, at: number) => { let n = 0; for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) n++; return n % 2 === 1; };

/**
 * remark-math pairs any two dollar runs of the same length, so `for i in $(seq 1 120); do echo $i`, "$5 and $10"
 * or `echo $$; kill $$` turn into equations. Pandoc's rule tells them apart: an opening run has a non-space right
 * after it, a closing run has a non-space right before it and no digit right after it. We also refuse closers and
 * openers that read as shell expansions (below). Escape every inline `$` or `$$` that does
 * not pair, so it renders as the literal text it is. Code, links and `$$` fences on their own line are left alone.
 */
export function escapeStrayDollars(text: string): string {
  if (!text.includes("$")) return text;
  const ranges = literalRanges(text, plainParser.parse(text), new Set(codeNodes));
  const inLiteral = (i: number) => ranges.some(([start, end]) => i >= start && i < end);
  // A `$$` (or longer) alone on its line fences display math; one with a command beside it (`echo $$`) is text.
  const fence = (i: number, size: number) => /(?:^|\n)[ \t]*$/.test(text.slice(0, i)) && /^[ \t]*(?:\n|$)/.test(text.slice(i + size));
  // Runs of any length pair (`echo $$$USER $$$HOME` is two three-dollar runs), so all go through the same check.
  const runs = Array.from(text.matchAll(/\$+/g))
    .filter((m) => !escaped(text, m.index!) && !inLiteral(m.index!) && !(m[0].length >= 2 && fence(m.index!, m[0].length)))
    .map((m) => ({ at: m.index!, size: m[0].length }));
  // A shell special parameter (`$?`, `$!`, `$#`, `$@`, `$*`) never opens math, so `"$?/$!"` stays literal.
  const opens = ({ at, size }: { at: number; size: number }) => at + size < text.length && !/[\s?!#@*]/.test(text[at + size]!);
  // Shell glues expansions to `=`, `:`, `/`, `.`, `-`, quotes and separators; an expression rarely ends on one.
  const shellBefore = (at: number) => /[=:/.\-(,;|&<>"]/.test(text[at - 1]!);
  // What follows a closer: `{` or `(` starts a shell expansion; a name does too after shell glue or a single quote
  // (`$HOME/$USER`, `'$dir' '$file'`), when it is an environment variable (`$HOME$USER`), or when the span is a
  // bare multi-letter name (`$first$last`); `the $n$th term` is math. A special parameter after shell glue is
  // shell (`status=$?`), while `Is $x$?` is math.
  type Run = { at: number; size: number };
  const closes = (open: Run, { at, size }: Run) => {
    const next = text.slice(at + size, at + size + 64);
    if (/\s/.test(text[at - 1]!) || /^[\d{(]/.test(next)) return false;
    if (/^[A-Za-z_]/.test(next)) {
      return !shellBefore(at) && text[at - 1] !== "'" && !/^[A-Z_][A-Z0-9_]+\b/.test(next)
        && !/^[A-Za-z_]\w+$/.test(text.slice(open.at + open.size, at));
    }
    return !(/^[?!#@*]/.test(next) && shellBefore(at));
  };
  const stray: Run[] = [];
  let open: Run | null = null, from = 0;
  for (let i = 0; i <= runs.length; i++) {
    const run = runs[i];
    if (open) {
      // Only a run of the same length can close; a different one is part of the expression.
      if (run && run.size !== open.size) continue;
      // Inline math never spans a blank line.
      if (run && closes(open, run) && !/\n[ \t]*\n/.test(text.slice(open.at, run.at))) { open = null; continue; }
      // No closer: the opener is literal, and the runs it skipped (`$USER $$; echo $HOME $$`) are text to check again.
      stray.push(open); open = null; i = from; continue;
    }
    if (!run) break;
    if (opens(run)) { open = run; from = i; } else stray.push(run);
  }
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
  const ranges = literalRanges(text, parser.parse(text), literalNodes);
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

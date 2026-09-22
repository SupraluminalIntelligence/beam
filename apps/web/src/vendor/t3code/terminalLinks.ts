/* Adapted from T3 Code, revision 1de563c1. Copyright (c) 2026 T3 Tools Inc.
 * MIT licensed; see LICENSE in this directory. */
// Beam uses URL matching for job logs; filesystem links need an authorized file resolver.
export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, "");
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1;
      const closes = output.split(close).length - 1;
      if (opens >= closes) return;
      output = output.slice(0, -1);
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0];
    const start = rawMatch.index ?? -1;
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}


export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  return collectMatches(line, "url", URL_PATTERN, []);
}
export function isTerminalUrl(value: string): boolean { return /^https?:\/\//iu.test(value); }

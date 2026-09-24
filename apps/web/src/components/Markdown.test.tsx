import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";
import { normalizeMath } from "../lib/math";

const render = (text: string, live = false) => renderToStaticMarkup(<Markdown text={text} handles={new Set(["codex"])} people={new Set()} live={live} />);

describe("chat math", () => {
  it("renders the screenshot's inline TeX and standard dollar notation", () => {
    const html = render(String.raw`Volume \(6.96\times10^{-10}\,\mathrm{m^3}\); step \(\Delta t\); error $10^{-12}$.`);
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html).toContain("<math");
    expect(html).not.toContain("katex-error");
    const unfinished = render("$$\nx^2", true);
    expect(unfinished).toContain('class="cursor"');
    expect(unfinished).not.toContain("katex-error");
  });

  it("renders both display delimiters and matrices", () => {
    for (const text of [String.raw`\[\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}\]`, "$$\nE=mc^2\n$$"]) {
      const html = render(text);
      expect(html).toContain('class="katex-display"');
      expect(html).not.toContain("katex-error");
    }
  });

  it("leaves inline code, fenced code, indented code, and URLs literal", () => {
    const text = '`\\(x\\)`\n\n```tex\n\\[x\\]\n$x$\n```\n\n    \\(y\\)\n\n[link](https://example.com/\\(x\\))';
    expect(normalizeMath(text)).toBe(text);
    expect(render(text)).not.toContain('class="katex"');
    expect(normalizeMath('```tex\n\\(unfinished code\\)')).toBe('```tex\n\\(unfinished code\\)');
  });

  it("preserves Markdown and mentions around equations", () => {
    const html = render(String.raw`- **Error** \(10^{-12}\) @codex`);
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>Error</strong>");
    expect(html).toContain('class="mention codex"');
    expect(html).toContain('class="katex"');
  });

  it("keeps incomplete or invalid math readable without breaking streaming", () => {
    expect(render(String.raw`\(\Delta`, true)).toContain('class="cursor"');
    expect(render(String.raw`$\frac{1}{$`)).toContain("katex-error");
    const html = render("$$\nx^2\n$$", true);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="cursor"');
    expect(html).not.toContain("katex-error");
  });

  it("preserves literal escapes, existing math, and unmatched currency", () => {
    expect(normalizeMath(String.raw`\\(literal\\)`)).toBe(String.raw`\\(literal\\)`);
    expect(normalizeMath(String.raw`$\text{\(literal\)}$`)).toBe(String.raw`$\text{\(literal\)}$`);
    expect(render("Costs $20.")).not.toContain('class="katex"');
  });

  it("does not allow TeX to load external images or create trusted links", () => {
    const html = render(String.raw`$\includegraphics{https://example.com/image.png}$ $\href{javascript:alert(1)}{click}$`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(render("[click](javascript:alert) ")).not.toContain('href="javascript:');
  });
});

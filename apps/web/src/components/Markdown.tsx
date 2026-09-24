import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { visit } from "unist-util-visit";
import { useMemo, type ReactNode } from "react";
import { MENTION } from "../lib/format";
import { normalizeMath } from "../lib/math";
import "katex/dist/katex.min.css";

/** Sentinel appended to live text; rendered as the streaming cursor at the true end of the content. */
export const CURSOR = "";

/**
 * Turns @mentions and the cursor sentinel into link nodes, so the `a` renderer below can draw them.
 * Keeps everything inside real markdown, so mentions inside list items or bold still work.
 */
type MathChild = { value?: string; children?: MathChild[] };

function remarkBeam(handles: Set<string>, people: Set<string>) {
  return () => (tree: unknown) => {
    // An unfinished display fence can absorb the live cursor into its math node.
    // Move it back into Markdown so it never becomes part of the TeX expression.
    visit(tree as never, ["math", "inlineMath"], (node: { type: string; value: string; data?: { hChildren?: MathChild[] } }, index: number | undefined, parent: { children: unknown[] } | undefined) => {
      if (!parent || index === undefined || !node.value.includes(CURSOR)) return;
      node.value = node.value.replaceAll(CURSOR, "");
      visit({ type: "root", children: node.data?.hChildren ?? [] } as never, "text", (child: { value: string }) => { child.value = child.value.replaceAll(CURSOR, ""); });
      const cursor = { type: "text", value: CURSOR };
      parent.children.splice(index + 1, 0, node.type === "math" ? { type: "paragraph", children: [cursor] } : cursor);
    });
    visit(tree as never, "text", (node: { type: string; value: string }, index: number | undefined, parent: { children: unknown[] } | undefined) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      if (!value.includes("@") && !value.includes(CURSOR)) return;
      const out: unknown[] = [];
      let last = 0;
      const re = new RegExp(`${MENTION.source}|${CURSOR}`, "gi");
      for (const m of value.matchAll(re)) {
        const full = m[0];
        const isCursor = full === CURSOR;
        const lead = isCursor ? "" : m[1] ?? "";
        const handle = isCursor ? "" : (m[2] ?? "").toLowerCase();
        const kind = isCursor ? "cursor" : handles.has(handle) ? "agent" : people.has(handle) ? "person" : null;
        if (!kind) continue;
        const at = m.index! + lead.length;
        if (at > last) out.push({ type: "text", value: value.slice(last, at) });
        out.push({ type: "link", url: `beam:${kind}:${handle}`, children: isCursor ? [] : [{ type: "text", value: `@${m[2]}` }] });
        last = at + full.length - lead.length;
      }
      if (!out.length) return;
      if (last < value.length) out.push({ type: "text", value: value.slice(last) });
      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}

const open = (href: string) => {
  const b = (window as unknown as { beam?: { openExternal?: (u: string) => void } }).beam;
  if (b?.openExternal) b.openExternal(href); else window.open(href, "_blank", "noopener");
};

export function Markdown({ text, handles, people, live = false }: { text: string; handles: Set<string>; people: Set<string>; live?: boolean }) {
  const plugins = [remarkGfm, remarkMath, remarkBreaks, remarkBeam(handles, people)];
  const source = useMemo(() => normalizeMath(text), [text]);
  // Keep the cursor outside a closing display-math fence during streaming.
  const content = live ? source + (/(?:^|\n)[ \t]*\${2,}[ \t]*$/.test(source) ? "\n\n" : "") + CURSOR : source;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={(url) => /^beam:(?:cursor:|(?:agent|person):[a-z0-9-]+)$/i.test(url) ? url : defaultUrlTransform(url)}
        rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", errorColor: "var(--ink-3)" }]]}
        components={{
          a: ({ href, children }: { href?: string | undefined; children?: ReactNode | undefined }) => {
            if (href?.startsWith("beam:cursor")) return <span className="cursor" />;
            if (href?.startsWith("beam:agent:")) { const h = href.slice(11); return <span className={`mention ${h === "codex" ? "codex" : h === "omp" ? "omp" : "claude"}`}>{children}</span>; }
            if (href?.startsWith("beam:person:")) return <span className="mention noah">{children}</span>;
            return <a href={href} onClick={(e) => { e.preventDefault(); if (href) open(href); }}>{children}</a>;
          },
          pre: ({ children }: { children?: ReactNode | undefined }) => <pre className="codeblock">{children}</pre>,
          code: ({ className, children }: { className?: string | undefined; children?: ReactNode | undefined }) => <code className={className}>{children}</code>,
          input: ({ checked }: { checked?: boolean | undefined }) => <span className={`cb${checked ? " on" : ""}`}>{checked ? "✓" : ""}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

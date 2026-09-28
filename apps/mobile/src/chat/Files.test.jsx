import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "convex/react";
import { AgentBody, PersonBody } from "./Rows";
import { DocumentPreview, MessageFiles } from "./Files";

// Native views and network calls are boundaries; exercise the real message bodies and viewer.
vi.mock("react-native", () => ({
  View: ({ children }) => <div>{children}</div>,
  ScrollView: ({ children }) => <div>{children}</div>,
  Text: ({ children }) => <span>{children}</span>,
  Pressable: ({ children, accessibilityLabel, disabled }) => <button aria-label={accessibilityLabel} disabled={disabled}>{children}</button>,
  Image: ({ source, accessibilityLabel }) => <img src={source.uri} alt={accessibilityLabel} />,
  StyleSheet: { hairlineWidth: 1, create: (s) => s }, Platform: { OS: "web" }, Linking: { openURL: vi.fn() },
}));
vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: () => vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: vi.fn(), back: vi.fn() } }));
vi.mock("expo-haptics", () => ({}));
vi.mock("../lib/convex", () => ({ api: { files: { preview: "files.preview" }, messages: { react: "messages.react" } } }));
vi.mock("../lib/hooks", () => ({ useNow: () => 0 }));
vi.mock("./model", () => ({ landingOf: vi.fn(), STEP_LABEL: {}, stepText: vi.fn() }));
vi.mock("../lib/theme", () => ({ useTheme: () => ({}), radius: {}, font: {} }));
vi.mock("../ui", () => ({
  T: ({ children }) => <span>{children}</span>, Avatar: () => null, AgentMark: () => null, Sq: () => null,
  Empty: ({ title, children }) => <div>{title}{children}</div>,
  TopBar: ({ title, right }) => <header>{title}{right}</header>,
  Button: ({ label }) => <button>{label}</button>,
}));
vi.mock("../ui/Screen", () => ({ Screen: ({ children }) => <main>{children}</main> }));

const screenshot = { name: "all-running.png", mime: "application/octet-stream", url: "https://files.example/screenshot", size: 2048 };
const message = { _id: "message1", author: "agent:claude", text: "", reactions: [], attachments: ["file1"] };
const common = { m: message, at: 0, cont: true, name: "Claude", me: "me", known: new Set() };
beforeEach(() => { vi.mocked(useQuery).mockReset(); vi.mocked(useQuery).mockReturnValue(screenshot); });

describe("mobile attachments", () => {
  it("renders an agent's screenshot-only message, including runner files with generic MIME types", () => {
    const html = renderToStaticMarkup(<AgentBody {...common} harness="claude" />);
    expect(html).toContain('src="https://files.example/screenshot"');
    expect(html).toContain('aria-label="Open all-running.png"');
    expect(useQuery).toHaveBeenCalledWith("files.preview", { id: "file1" });
  });

  it("renders human attachments alongside text and preserves every attachment", () => {
    const html = renderToStaticMarkup(<PersonBody {...common} image={null} m={{ ...message, author: "me", text: "Two screenshots", attachments: ["file1", "file2"] }} />);
    expect(html).toContain("Two screenshots");
    expect(html.match(/aria-label="Open all-running.png"/g)).toHaveLength(2);
    expect(useQuery).toHaveBeenCalledWith("files.preview", { id: "file2" });
  });

  it("keeps ordinary messages free of attachment queries", () => {
    expect(renderToStaticMarkup(<MessageFiles />)).toBe("");
    expect(useQuery).not.toHaveBeenCalled();
  });

  it("distinguishes loading and deleted attachments instead of leaving a blank message", () => {
    vi.mocked(useQuery).mockReturnValue(undefined);
    expect(renderToStaticMarkup(<MessageFiles ids={["file1"]} />)).toContain("Loading attachment");
    vi.mocked(useQuery).mockReturnValue(null);
    const html = renderToStaticMarkup(<MessageFiles ids={["file1"]} />);
    expect(html).toContain("Attachment unavailable");
    expect(html).toContain("disabled");
  });

  it("renders document text and offers the original for PDFs and other file types", () => {
    expect(renderToStaticMarkup(<DocumentPreview file={{ ...screenshot, name: "notes.txt", mime: "text/plain", text: "Inspection passed" }} />)).toContain("Inspection passed");
    const pdf = renderToStaticMarkup(<DocumentPreview file={{ ...screenshot, name: "report.pdf", mime: "application/pdf" }} />);
    expect(pdf).toContain("Open original");
    expect(pdf).toContain("Open this file in another app");
    expect(renderToStaticMarkup(<DocumentPreview file={null} />)).toContain("File unavailable");
  });
});

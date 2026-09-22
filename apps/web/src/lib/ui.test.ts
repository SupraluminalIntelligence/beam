import { beforeEach, afterEach, expect, it, vi } from "vitest";
beforeEach(() => { vi.resetModules(); vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
it("navigates between chats across workspaces and discards forward history after a new visit", async () => {
  const { ui } = await import("./ui");
  ui.openChat("one", "a"); ui.openChat("one", "b"); ui.openChat("two", "c");
  ui.navigateHistory(-1);
  expect(ui.get().ws).toBe("one"); expect(ui.get().active.one).toBe("b");
  ui.navigateHistory(-1); expect(ui.get().active.one).toBe("a");
  ui.navigateHistory(1); expect(ui.get().active.one).toBe("b");
  ui.openChat("one", "d"); ui.navigateHistory(1);
  expect(ui.get().active.one).toBe("d"); expect(ui.get().navigation.some(n => n.chat === "c")).toBe(false);
});
it("avoids duplicate visits, respects history bounds, and restores closed tabs", async () => {
  const { ui } = await import("./ui");
  ui.openChat("one", "a"); ui.openChat("one", "a");
  expect(ui.get().navigation).toHaveLength(1);
  ui.navigateHistory(-1); expect(ui.get().navigationIndex).toBe(0);
  ui.openChat("one", "b"); ui.closeChat("one", "a"); ui.navigateHistory(-1);
  expect(ui.get().tabs.one).toContain("a"); expect(ui.get().active.one).toBe("a");
  ui.toggleSidebar(); expect(ui.get().sidebarHidden).toBe(true);
  ui.toggleSidebar(); expect(ui.get().sidebarHidden).toBe(false);
});
it("keeps pins personal, persists them, and unpins without closing the chat", async () => {
  const { ui } = await import("./ui");
  ui.openChat("ws", "chat");
  ui.togglePin("alice", "ws", "chat");
  expect(ui.get().pinnedChats.alice).toEqual([{ workspaceId: "ws", chatId: "chat" }]);
  expect(ui.get().pinnedChats.bob).toBeUndefined();
  const saved = vi.mocked(localStorage.setItem).mock.calls.at(-1)![1];
  expect(JSON.parse(saved).pinnedChats.alice).toHaveLength(1);
  ui.togglePin("alice", "ws", "chat");
  expect(ui.get().pinnedChats.alice).toEqual([]);
  expect(ui.get().active.ws).toBe("chat");
});

it("remembers a resized sidebar while hidden and after reloading", async () => {
  const { ui } = await import("./ui");
  ui.setSidebarWidth(337);
  ui.toggleSidebar();
  const saved = vi.mocked(localStorage.setItem).mock.calls.at(-1)![1];
  vi.stubGlobal("localStorage", { getItem: () => saved, setItem: vi.fn() });
  vi.resetModules();
  const restored = (await import("./ui")).ui;
  expect(restored.get().sidebarHidden).toBe(true);
  restored.toggleSidebar();
  expect(restored.get().sidebarWidth).toBe(337);
  restored.toggleSidebar(); restored.toggleSidebar();
  expect(restored.get().sidebarWidth).toBe(337);
});

it("opens CAD attachments and durable result references in a single per-chat tool tab", async () => {
  const { ui } = await import("./ui");
  ui.openFile("a", "file", "part.STEP");
  expect(ui.get().panels.a?.active).toBe("cad");
  expect(ui.get().panels.a?.cadReference).toEqual({ kind: "file", id: "file" });
  ui.openCad("a", { kind: "result", jobId: "job", assetId: "asset" });
  expect(ui.get().panels.a?.tabs).toEqual(["cad"]);
  ui.openFile("b", "doc", "notes.txt");
  expect(ui.get().panels.b?.active).toBe("files");
  expect(ui.get().panels.a?.cadReference).toEqual({ kind: "result", jobId: "job", assetId: "asset" });
});

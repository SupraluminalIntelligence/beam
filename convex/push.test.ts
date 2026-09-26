import { describe, expect, it } from "vitest";
import { deadTokens, isPushToken, pushMessages } from "./push";

const row = { _id: "n1", kind: "input", title: "Your Claude Code needs your input", body: "Mobile RC design", chatId: "chat", workspaceId: "ws", messageId: null, readAt: null } as never;
const tokens = ["ExponentPushToken[aaaaaaaaaaaa]", "ExponentPushToken[bbbbbbbbbbbb]"];
const away = { muted: false, focusedHere: false };

describe("push", () => {
  it("accepts only Expo push tokens", () => {
    expect(isPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isPushToken("ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]")).toBe(true);
    expect(isPushToken("apns:abcdef")).toBe(false);
    expect(isPushToken("ExponentPushToken[]")).toBe(false);
  });
  it("sends one message per phone, grouped by chat, with where to open", () => {
    const m = pushMessages(row, tokens, undefined, away);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ to: tokens[0], threadId: "chat", sound: "default", data: { chatId: "chat", kind: "input", notificationId: "n1" } });
  });
  it("respects preferences, mute, read state and where you are looking", () => {
    expect(pushMessages(row, tokens, { enabled: false }, away)).toEqual([]);
    expect(pushMessages(row, tokens, { input: false }, away)).toEqual([]);
    expect(pushMessages(row, tokens, undefined, { muted: true, focusedHere: false })).toEqual([]);
    expect(pushMessages(row, tokens, undefined, { muted: false, focusedHere: true })).toEqual([]);
    expect(pushMessages({ ...(row as object), readAt: 1 } as never, tokens, undefined, away)).toEqual([]);
    expect(pushMessages(row, tokens, { sound: false }, away)[0]!.sound).toBeNull();
  });
  it("forgets only tokens Expo reports as unregistered", () => {
    const msgs = tokens.map((to) => ({ to }));
    expect(deadTokens(msgs, [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }])).toEqual([tokens[1]]);
    expect(deadTokens(msgs, [{ status: "error", details: { error: "MessageRateExceeded" } }, { status: "ok" }])).toEqual([]);
  });
});

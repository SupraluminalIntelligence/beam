import type { ActivityLine, RunView, TurnView } from "@beam/reducer";
import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { api, type Id } from "../lib/convex";
import { duration, elapsed, hhmm } from "../lib/format";
import { useNow } from "../lib/hooks";
import { font, radius, useTheme } from "../lib/theme";
import { AgentMark, Avatar, Sq, T } from "../ui";
import { landingOf, STEP_LABEL, stepText, type Run } from "./model";
import { Rich } from "./Rich";

const tap = () => { if (Platform.OS !== "web") void Haptics.selectionAsync(); };

/** Avatar column plus a header line; continuation rows drop both. */
export function Frame({ avatar, name, at, cont, children }: { avatar: React.ReactNode; name: string; at: number; cont: boolean; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginTop: cont ? 4 : 14 }}>
      <View style={{ width: 28 }}>{cont ? null : avatar}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {cont ? null : <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
          <T mono caps weight="semi" size={11} lines={1} style={{ letterSpacing: 0.5, flexShrink: 1 }}>{name}</T>
          <T mono size={11} tone="ink3">{hhmm(at)}</T>
        </View>}
        {children}
      </View>
    </View>
  );
}

type Msg = { _id: Id<"messages">; author: string; text: string; reactions: { emoji: string; by: string[] }[] };

/** Reaction chips under a message. Tap toggles yours. */
export function Reactions({ m, me }: { m: Msg; me: string }) {
  const t = useTheme();
  const react = useMutation(api.messages.react);
  if (!m.reactions.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
      {m.reactions.map((r) => (
        <Pressable key={r.emoji} onPress={() => { tap(); void react({ messageId: m._id, emoji: r.emoji }); }} accessibilityLabel={`${r.emoji} ${r.by.length}`} style={{ flexDirection: "row", alignItems: "center", gap: 5, minHeight: 30, paddingHorizontal: 9, borderWidth: 1, borderColor: r.by.includes(me) ? t.ink : t.line2, borderRadius: radius.control, backgroundColor: t.surface }}>
          <T size={14}>{r.emoji}</T><T mono size={11} tone="ink2">{r.by.length}</T>
        </Pressable>
      ))}
    </View>
  );
}

export type Anchor = { x: number; y: number; w: number; h: number; touchX: number; touchY: number };

/** Press-and-hold anywhere on a message. Reports where the message sits and where the finger is, so the menu can grow from there. */
function Holdable({ onHold, lifted, children }: { onHold: (a: Anchor) => void; lifted: boolean; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  return (
    <Pressable ref={ref} delayLongPress={300} style={({ pressed }) => ({ opacity: lifted ? 0 : 1, transform: [{ scale: pressed && !lifted ? 0.985 : 1 }] })}
      onLongPress={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        ref.current?.measureInWindow((x, y, w, h) => onHold({ x, y, w, h, touchX: pageX, touchY: pageY }));
      }}>
      {children}
    </Pressable>
  );
}

/** What a person's message looks like, shared by the row and its lifted copy so the two match pixel for pixel. */
export function PersonBody({ m, at, cont, name, image, me, known }: { m: Msg; at: number; cont: boolean; name: string; image: string | null; me: string; known: Set<string> }) {
  return (
    <Frame avatar={<Avatar login={m.author} name={name} image={image} size={26} />} name={name} at={at} cont={cont}>
      {m.text ? <Rich text={m.text} known={known} /> : null}
      <Reactions m={m} me={me} />
    </Frame>
  );
}

export function AgentBody({ m, harness, name, at, cont, known, me }: { m: Msg; harness: string; name: string; at: number; cont: boolean; known: Set<string>; me: string }) {
  return (
    <Frame avatar={<AgentMark harness={harness} size={26} />} name={name} at={at} cont={cont}>
      <Rich text={m.text} known={known} />
      <Reactions m={m} me={me} />
    </Frame>
  );
}

type BodyProps<P> = P & { onHold: (a: Anchor) => void; lifted: boolean };
export function PersonMessage({ onHold, lifted, ...p }: BodyProps<React.ComponentProps<typeof PersonBody>>) {
  return <Holdable onHold={onHold} lifted={lifted}><PersonBody {...p} /></Holdable>;
}
export function AgentReply({ onHold, lifted, ...p }: BodyProps<React.ComponentProps<typeof AgentBody>>) {
  return <Holdable onHold={onHold} lifted={lifted}><AgentBody {...p} /></Holdable>;
}

function Step({ a, now }: { a: ActivityLine; now: number }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const running = a.ok === null && a.startedAt ? elapsed(now - a.startedAt) : null;
  return (
    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }}>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 38 }}>
        <Sq state={a.ok === null ? "work" : a.ok ? "ok" : "bad"} size={7} />
        <T mono size={11.5} tone="ink3" style={{ width: 40 }}>{STEP_LABEL[a.kind] ?? a.kind.slice(0, 5)}</T>
        <T mono size={11.5} lines={1} style={{ flex: 1 }}>{stepText(a.kind, a.summary)}</T>
        <T mono size={11} tone={running ? "live" : "ink3"}>{running ?? duration(a.ms)}</T>
      </Pressable>
      {open ? <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 6 }}>
        <T mono size={11} tone="ink2" selectable>{a.summary}</T>
        <View style={{ backgroundColor: t.surface2, padding: 8 }}><T mono size={11} tone="ink2" selectable lines={40}>{a.detail ?? (a.ok === null ? "still running" : "no output")}</T></View>
      </View> : null}
    </View>
  );
}

/** One turn's tool calls: open while it runs, folded when done or when the agent is waiting on you. */
export function Activity({ turn, live, waiting, agent }: { turn: TurnView; live: boolean; waiting: boolean; agent: string }) {
  const t = useTheme();
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(live);
  const isOpen = open ?? (live && !waiting);
  const n = turn.activity.length;
  const start = turn.activity[0]?.startedAt ?? turn.startedAt;
  const failed = turn.activity.filter((a) => a.ok === false).length;
  const title = live ? (waiting ? `waiting on you · ${n} step${n === 1 ? "" : "s"}` : n ? `${agent} is working · ${n} step${n === 1 ? "" : "s"}` : `${agent} is thinking`) : `${n} step${n === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;
  const time = live && start ? elapsed(now - start) : turn.endedAt && start ? duration(turn.endedAt - start) : "";
  return (
    <View style={{ marginTop: 6, borderWidth: 1, borderColor: t.line, borderRadius: radius.object, overflow: "hidden", backgroundColor: t.surface }}>
      <Pressable onPress={() => setOpen(!isOpen)} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, minHeight: 44, backgroundColor: t.surface2 }}>
        <T mono size={11} tone="ink3">{isOpen ? "▾" : "▸"}</T>
        <T mono size={12} tone="ink2" lines={1} style={{ flex: 1 }}>{title}</T>
        <Sq state={live ? (waiting ? "warn" : "work") : failed ? "bad" : "ok"} size={7} />
        <T mono size={11} tone="ink2">{time}</T>
      </Pressable>
      {isOpen ? turn.activity.map((a) => <Step key={a.itemId} a={a} now={now} />) : null}
    </View>
  );
}

/** A question or approval the agent is waiting on. Anyone in the chat can answer; the first answer wins. */
export function Requests({ run, view }: { run: Run; view: RunView }) {
  const t = useTheme();
  const respond = useMutation(api.runs.respond);
  const [answer, setAnswer] = useState("");
  const send = (requestId: string, decision: string) => { tap(); void respond({ runId: run._id, requestId, decision }); };
  return <>{view.requests.map((r) => (
    <View key={r.requestId} style={{ marginTop: 8, borderWidth: 1, borderColor: t.warn, borderRadius: radius.object, overflow: "hidden", backgroundColor: t.surface }}>
      <View style={{ padding: 12, gap: 6 }}>
        <T mono caps size={10} tone="warn">{r.kind === "input" ? "waiting for an answer" : "waiting for approval"}</T>
        <T mono={r.kind === "approval"} size={r.kind === "approval" ? 13 : 15} selectable>{r.prompt}</T>
      </View>
      {r.kind === "approval" ? (
        <View style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }}>
          {(r.options ?? ["allow", "deny"]).map((o, i, all) => (
            <Pressable key={o} onPress={() => send(r.requestId, o)} style={({ pressed }) => ({ flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", borderRightWidth: i < all.length - 1 ? StyleSheet.hairlineWidth : 0, borderRightColor: t.line, backgroundColor: pressed ? t.surface2 : "transparent" })}>
              <T mono size={13} tone={o === "deny" ? "bad" : "ink"}>{o}</T>
            </Pressable>
          ))}
        </View>
      ) : (
        <>
          {(r.options ?? []).map((o) => <Pressable key={o} onPress={() => send(r.requestId, o)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }}><T mono size={13}>{o}</T></Pressable>)}
          <View style={{ flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line }}>
            <TextInput value={answer} onChangeText={setAnswer} placeholder="Type an answer" placeholderTextColor={t.ink3} style={{ flex: 1, minHeight: 48, paddingHorizontal: 14, color: t.ink, fontFamily: font.sans, fontSize: 15 }} onSubmitEditing={() => answer.trim() && send(r.requestId, answer.trim())} returnKeyType="send" />
            <Pressable disabled={!answer.trim()} onPress={() => send(r.requestId, answer.trim())} style={{ paddingHorizontal: 16, justifyContent: "center", borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.line, opacity: answer.trim() ? 1 : 0.4 }}><T mono size={13}>Send</T></Pressable>
          </View>
        </>
      )}
    </View>
  ))}</>;
}

/** The state line for a live run with nothing else to show yet. */
export function RunStatus({ run, view }: { run: Run; view: RunView | null }) {
  const t = useTheme();
  const text = run.state === "queued" ? `waiting for ${run.runnerName}` : run.state === "starting" ? `preparing worktree on ${run.runnerName}` : run.state === "landing" ? "pushing" : run.state === "working" && !view?.turns.length ? `starting on ${run.runnerName}` : view?.note ?? null;
  if (!text) return null;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}><Sq state="work" size={7} /><T mono size={12} tone="ink2">{text}</T></View>;
}

/** What a run left behind, one card per repo. Failures say so in the failure colour. */
export function Landing({ run, view, onOpen }: { run: Run; view: RunView | null; onOpen: () => void }) {
  const t = useTheme();
  const l = landingOf(run);
  const error = l.error ?? (run.state === "failed" || run.state === "interrupted" ? view?.errors.at(-1) ?? (run.state === "interrupted" ? "stopped" : "run failed") : null);
  if (error) return <View style={{ flexDirection: "row", gap: 8, alignItems: "center", marginTop: 8 }}><Sq state="bad" size={7} /><T mono size={12} tone="bad" style={{ flex: 1 }}>{error}</T></View>;
  return <>{l.repos.map((r) => (
    <Pressable key={r.repo} onPress={onOpen} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8, padding: 12, borderWidth: 1, borderColor: t.line, borderRadius: radius.object, backgroundColor: pressed ? t.surface2 : t.surface })}>
      <View style={{ width: 30, height: 30, borderWidth: 1, borderColor: t.line, borderRadius: radius.control, alignItems: "center", justifyContent: "center" }}><T mono>⎇</T></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <T mono weight="semi" size={13} lines={1}>{r.branch}</T>
        <T mono size={11} tone="ink3" lines={1}>{r.repo.split("/")[1]} · {r.pushed ? "pushed" : "not pushed"}{r.pushed ? <> · <T mono size={11} tone="add">+{r.add}</T> <T mono size={11} tone="del">−{r.del}</T> · {r.files} files</> : null}{r.prUrl ? " · PR" : ""}</T>
        {r.error ? <T mono size={11} tone="bad">{r.error}</T> : null}
      </View>
    </Pressable>
  ))}</>;
}

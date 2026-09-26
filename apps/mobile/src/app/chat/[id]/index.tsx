import { useMutation } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChat } from "../../../chat/model";
import { Activity, AgentBody, AgentReply, Frame, Landing, PersonBody, PersonMessage, Requests, RunStatus } from "../../../chat/Rows";
import { MessageActions, type Held } from "../../../chat/Actions";
import { HARNESS } from "../../../lib/agents";
import { api, type Id } from "../../../lib/convex";
import { dayLabel } from "../../../lib/format";
import { font, radius, useTheme } from "../../../lib/theme";
import { AgentMark, Avatar, Empty, Icon, Sq, Stack, T, TopBar } from "../../../ui";
import { Screen } from "../../../ui/Screen";

const MENTION = /(^|\s)@([a-z0-9-]+)\b/gi;

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = id as Id<"chats">;
  const t = useTheme();
  const c = useChat(chatId);
  const focus = useMutation(api.presence.focus);
  const list = useRef<FlatList>(null);
  const atBottom = useRef(true);
  const input = useRef<TextInput>(null);
  const [draft, setDraft] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(null), 1600); return () => clearTimeout(id); }, [notice]);
  const insert = (text: string) => { setDraft((d) => (d && !d.endsWith(" ") && !d.endsWith("\n") ? `${d} ${text}` : `${d}${text}`)); setTimeout(() => input.current?.focus(), 250); };

  // Presence: this chat is the one you have focused, heartbeat like the desktop.
  useEffect(() => {
    if (!c.chat) return;
    const ws = c.chat.workspaceId;
    void focus({ workspaceId: ws, chatId });
    const timer = setInterval(() => void focus({ workspaceId: ws, chatId }), 45_000);
    return () => { clearInterval(timer); void focus({ workspaceId: ws, chatId: null }); };
  }, [c.chat?.workspaceId, chatId, focus]);

  const handles = useMemo(() => new Set((c.detail?.agents ?? []).map((a) => a.handle)), [c.detail]);
  const known = useMemo(() => new Set([...handles, ...(c.detail?.members ?? [])]), [handles, c.detail]);

  if (c.chat === undefined) return <Screen><TopBar title="" onBack={() => router.back()} /></Screen>;
  if (c.chat === null) return <Screen><TopBar title="Chat" onBack={() => router.back()} /><Empty title="This chat is gone.">It was deleted, or you no longer have access.</Empty></Screen>;
  const chat = c.chat;
  const others = c.here.filter((l) => l !== c.login);
  const status = c.waiting ? { tone: "warn" as const, text: `${c.nameOfRun(c.waiting)} is waiting on you` } : c.live ? { tone: "live" as const, text: `${c.nameOfRun(c.live)} is working` } : null;
  const crewState = c.waiting ? "warn" : c.live ? "work" : null;
  const gitTag = c.unpushed ? String(c.unpushed) : c.open?.prNumber ? `#${c.open.prNumber}` : null;
  const openDetails = () => router.push({ pathname: "/chat/[id]/details", params: { id: chatId } });

  return (
    <Screen>
      <TopBar
        onBack={() => router.back()}
        onTitle={openDetails}
        nameCase
        title={chat.title}
        sub={status ? <T mono size={10.5} tone={status.tone}>{status.text}</T> : (c.detail?.name ?? "")}
        right={<>
          <Pressable onPress={openDetails} hitSlop={4} accessibilityLabel="Code and machines" style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 44, paddingHorizontal: 6 }}>
            <Icon name="branch" size={20} />{gitTag ? <T mono size={11} tone="ink2">{gitTag}</T> : null}
          </Pressable>
          <Pressable onPress={() => router.push({ pathname: "/chat/[id]/people", params: { id: chatId } })} accessibilityLabel="People and agents in this chat" style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingLeft: 6, paddingRight: 6 }}>
            {others.length ? <Stack size={26}>{others.slice(0, 3).map((l) => <Avatar key={l} login={l} name={c.nameOf(l)} image={c.imageOf(l)} size={26} />)}</Stack> : null}
            {c.crew.length ? <View>
              <Stack size={24}>{c.crew.slice(0, 3).map((a) => <AgentMark key={`${a.harness}:${a.owner}`} harness={a.harness} size={24} />)}</Stack>
              {crewState ? <View style={{ position: "absolute", right: -2, top: -3 }}><Sq state={crewState} size={7} /></View> : null}
            </View> : null}
            {!others.length && !c.crew.length ? <Icon name="more" /> : null}
          </Pressable>
        </>}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlatList
          ref={list}
          data={c.rows}
          keyExtractor={(r) => r.key}
          extraData={held?.id}
          contentContainerStyle={{ paddingBottom: 12 }}
          onScroll={(e) => { const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent; atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80; }}
          scrollEventThrottle={64}
          onContentSizeChange={() => { if (atBottom.current) list.current?.scrollToEnd({ animated: false }); }}
          ListHeaderComponent={c.messages?.length ? <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingTop: 14 }}><View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.line }} /><T mono caps size={10} tone="ink3">Started {dayLabel(chat._creationTime)}</T><View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.line }} /></View> : null}
          ListEmptyComponent={c.messages ? <Empty title="Nothing here yet.">Say something, or @mention an agent. The chat gets a branch when the first agent is dispatched.</Empty> : null}
          renderItem={({ item: row }) => {
            if (row.kind === "message") {
              const m = row.message;
              if (m.author.startsWith("agent:")) {
                const run = c.runs?.find((r) => r._id === m.runId);
                const harness = run ? c.harnessOf(run) : "claude", name = run ? c.nameOfRun(run) : "Agent", handle = run ? c.agentOfRun(run)?.handle : null;
                const body = { m, harness, name, at: row.at, cont: row.cont, known, me: c.login };
                return <AgentReply {...body} lifted={held?.id === m._id}
                  onHold={(anchor) => setHeld({ anchor, id: m._id, text: m.text, body: <AgentBody {...body} />, reactions: m.reactions, mention: handle ? { handle, label: HARNESS[harness]?.name ?? handle } : null })} />;
              }
              const who = m.author === c.login ? "You" : c.nameOf(m.author);
              const body = { m, at: row.at, cont: row.cont, name: who, image: c.imageOf(m.author), me: c.login, known };
              return <PersonMessage {...body} lifted={held?.id === m._id}
                onHold={(anchor) => setHeld({ anchor, id: m._id, text: m.text, body: <PersonBody {...body} />, reactions: m.reactions, mention: m.author === c.login ? null : { handle: m.author, label: who.split(" ")[0]! } })} />;
            }
            const run = row.run, view = c.views[run._id] ?? null, name = c.nameOfRun(run);
            const waiting = !!view?.requests.length;
            return (
              <AgentFrame harness={c.harnessOf(run)} name={name} at={row.at} cont={row.cont}>
                {row.kind === "activity" ? <Activity turn={row.turn} live={row.live} waiting={waiting} agent={name} /> : null}
                {row.kind === "status" ? <><RunStatus run={run} view={view} />{view ? <Requests run={run} view={view} /> : null}</> : null}
                {row.kind === "landing" ? <Landing run={run} view={view} onOpen={openDetails} /> : null}
              </AgentFrame>
            );
          }}
        />
        {notice ? <View pointerEvents="none" style={{ position: "absolute", alignSelf: "center", bottom: 90, backgroundColor: t.ink, paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.control }}><T mono size={12} tone="surface">{notice}</T></View> : null}
        <Composer inputRef={input} text={draft} setText={setDraft} chatId={chatId} handles={handles} members={(c.detail?.members ?? []).filter((m) => m !== c.login)} agents={c.detail?.agents ?? []} nameOf={c.nameOf} live={c.live?._id ?? null} onSent={() => { atBottom.current = true; }} />
      </KeyboardAvoidingView>
      <MessageActions held={held} me={c.login} onClose={() => setHeld(null)} onCopied={() => setNotice("Copied")}
        onMention={(h) => insert(`@${h} `)}
        onReply={(h) => insert(`> ${h.text.split("\n").filter(Boolean).slice(0, 3).join("\n> ").slice(0, 280)}\n\n`)} />
    </Screen>
  );
}

function AgentFrame({ harness, name, at, cont, children }: { harness: string; name: string; at: number; cont: boolean; children: React.ReactNode }) {
  return <Frame avatar={<AgentMark harness={harness} size={26} />} name={name} at={at} cont={cont}>{children}</Frame>;
}

type Agent = { _id: string; harness: string; handle: string; model: string; effort: string };
function Composer({ inputRef, text, setText, chatId, handles, members, agents, nameOf, live, onSent }: { inputRef: React.RefObject<TextInput | null>; text: string; setText: (v: string) => void; chatId: Id<"chats">; handles: Set<string>; members: string[]; agents: Agent[]; nameOf: (l: string) => string; live: Id<"runs"> | null; onSent: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const send = useMutation(api.messages.send);
  const stop = useMutation(api.runs.interrupt);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const q = text.match(/(?:^|\s)@([a-z0-9-]*)$/i)?.[1]?.toLowerCase();
  const picks = q === undefined ? [] : [
    ...agents.filter((a) => a.handle.startsWith(q) || (HARNESS[a.harness]?.name ?? "").toLowerCase().startsWith(q)).map((a) => ({ v: a.handle, label: HARNESS[a.harness]?.name ?? a.handle, d: `${a.model} · ${a.effort}`, agent: a.harness })),
    ...members.filter((m) => m.startsWith(q)).map((m) => ({ v: m, label: nameOf(m), d: "member", agent: null as string | null })),
  ];
  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    const mention = [...body.matchAll(MENTION)].map((m) => m[2]!.toLowerCase()).find((h) => handles.has(h)) ?? null;
    setSending(true); setError(null);
    try { await send({ chatId, text: body, mentionHandle: mention }); setText(""); onSent(); }
    catch (e) { setError(String((e as Error).message).replace(/^.*Uncaught Error: /, "").split("\n")[0]!.slice(0, 160)); }
    setSending(false);
  }
  return (
    <View style={{ paddingBottom: Math.max(insets.bottom, 8) }}>
      {picks.length ? (
        <View style={{ marginHorizontal: 12, marginBottom: 6, borderWidth: 1, borderColor: t.line2, backgroundColor: t.surface, borderRadius: radius.object, overflow: "hidden" }}>
          {picks.map((p) => (
            <Pressable key={p.v} onPress={() => setText(text.replace(/@[a-z0-9-]*$/i, `@${p.v} `))} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 46, paddingHorizontal: 12, backgroundColor: pressed ? t.surface2 : "transparent" })}>
              {p.agent ? <AgentMark harness={p.agent} /> : <Avatar login={p.v} name={p.label} size={24} />}
              <T style={{ flex: 1 }}>{p.label}</T>
              <T mono size={11} tone="ink3">{p.d}</T>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <T mono size={11} tone="warn" style={{ marginHorizontal: 14, marginBottom: 4 }}>{error}</T> : null}
      <View style={{ marginHorizontal: 12, borderWidth: 1, borderColor: t.line2, borderRadius: radius.composer, paddingLeft: 12, paddingRight: 8, paddingVertical: 6, backgroundColor: t.surface, flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          ref={inputRef}
          value={text} onChangeText={setText} multiline placeholder="Message · @ to mention" placeholderTextColor={t.ink3}
          style={{ flex: 1, minHeight: 36, maxHeight: 120, paddingTop: 8, paddingBottom: 8, color: t.ink, fontFamily: font.sans, fontSize: 16 }}
          onKeyPress={(e) => { if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !(e as unknown as { shiftKey?: boolean }).shiftKey) { e.preventDefault(); void submit(); } }}
        />
        {live ? <Pressable onPress={() => void stop({ runId: live })} style={{ height: 36, paddingHorizontal: 12, borderWidth: 1, borderColor: t.line2, borderRadius: radius.control, justifyContent: "center" }}><T mono size={12} tone="ink2">Stop</T></Pressable> : null}
        <Pressable disabled={!text.trim() || sending} onPress={() => void submit()} accessibilityLabel="Send" style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderWidth: 1, borderColor: text.trim() ? t.ink : t.line2, backgroundColor: text.trim() ? t.ink : "transparent" }}>
          <Icon name="send" size={16} color={text.trim() ? t.surface : t.ink3} />
        </Pressable>
      </View>
    </View>
  );
}

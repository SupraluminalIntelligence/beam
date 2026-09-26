import { useQuery } from "convex/react";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { agentName, chatStatus, ownerOf } from "../../lib/agents";
import { api, type Doc, type Id } from "../../lib/convex";
import { ago, elapsed } from "../../lib/format";
import { useMe, useNow, usePeople } from "../../lib/hooks";
import { space, useTheme } from "../../lib/theme";
import { Avatar, Empty, Icon, Row, Sq, Stack, T, Tile } from "../../ui";
import { Screen } from "../../ui/Screen";

/** Home: every workspace you are in, each a band with its chats under it. Nothing pinned, no recents. */
export default function Chats() {
  const t = useTheme();
  const workspaces = useQuery(api.workspaces.mine);
  const inbox = useQuery(api.notifications.inbox);
  const waiting = useMemo(() => new Set((inbox ?? []).filter((n) => n.kind === "input" && n.readAt === null).map((n) => n.chatId as string)), [inbox]);
  return (
    <Screen>
      <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingLeft: space.padX, paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 9 }}>
          <Image source={require("../../../assets/mark.png")} style={{ width: 16, height: 16 }} />
          <T display weight="bold" size={16} caps style={{ letterSpacing: 1.3 }}>Beam</T>
        </View>
      </View>
      <ScrollView>
        {workspaces === undefined ? null : workspaces.length === 0
          ? <Empty title="No workspaces yet.">Create one on Beam's desktop or web app, or ask a teammate to invite your GitHub login.</Empty>
          : workspaces.map((w) => <Workspace key={w.id} id={w.id} name={w.name} waiting={waiting} />)}
        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

type Counts = Record<string, "waiting" | "working" | "failed" | "none">;

function Workspace({ id, name, waiting }: { id: Id<"workspaces">; name: string; waiting: Set<string> }) {
  const t = useTheme();
  const me = useMe();
  const chats = useQuery(api.chats.list, { workspaceId: id });
  const detail = useQuery(api.workspaces.detail, { workspaceId: id });
  const presence = useQuery(api.presence.inWorkspace, { workspaceId: id });
  const { nameOf, imageOf } = usePeople(detail?.members ?? []);
  const [folded, setFolded] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [counts, setCounts] = useState<Counts>({});
  const report = useCallback((chatId: string, s: Counts[string]) => setCounts((c) => (c[chatId] === s ? c : { ...c, [chatId]: s })), []);
  const open = (chats ?? []).filter((c) => !c.state || c.state === "open");
  const settled = (chats ?? []).filter((c) => c.state === "settled");
  const nWaiting = open.filter((c) => counts[c._id] === "waiting").length, nWorking = open.filter((c) => counts[c._id] === "working").length;
  const around = [...new Set((presence ?? []).filter((p) => p.login !== me?.githubLogin && p.chatId).map((p) => p.login))];
  const row = (c: Doc<"chats">) => <ChatRow key={c._id} chat={c} agents={detail?.agents ?? []} waiting={waiting.has(c._id)} here={(presence ?? []).filter((p) => p.chatId === c._id && p.login !== me?.githubLogin).map((p) => p.login)} nameOf={nameOf} imageOf={imageOf} me={me?.githubLogin ?? ""} report={report} />;
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 62, paddingLeft: space.padX, paddingRight: 4, backgroundColor: t.surface2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line2 }}>
        <Pressable onPress={() => router.push({ pathname: "/workspace/[id]", params: { id } })} style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}>
          <Tile name={name} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T display weight="semi" size={17} lines={1}>{name}</T>
            {nWaiting || nWorking ? <T mono size={10.5} lines={1} tone="ink3">
              {nWaiting ? <T mono size={10.5} tone="warn">{nWaiting} waiting on you</T> : null}
              {nWaiting && nWorking ? " · " : ""}
              {nWorking ? <T mono size={10.5} tone="live">{nWorking} running</T> : null}
            </T> : null}
          </View>
        </Pressable>
        {around.length ? <Stack size={20}>{around.slice(0, 3).map((l) => <Avatar key={l} login={l} name={nameOf(l)} image={imageOf(l)} size={20} />)}</Stack> : null}
        <Pressable onPress={() => setFolded(!folded)} hitSlop={6} style={{ width: 42, height: 42, alignItems: "center", justifyContent: "center" }} accessibilityLabel={folded ? `Expand ${name}` : `Collapse ${name}`}>
          <View style={{ transform: [{ rotate: folded ? "-90deg" : "0deg" }] }}><Icon name="down" size={15} /></View>
        </Pressable>
      </View>
      {folded ? null : <>
        {open.map(row)}
        {chats && !open.length ? <Empty title="No open chats.">Start one from the desktop app for now.</Empty> : null}
        {settled.length ? <Pressable onPress={() => setShowSettled(!showSettled)} style={{ minHeight: 42, justifyContent: "center", paddingLeft: space.padX + 30 }}><T mono size={12} tone="ink3">{showSettled ? "▾" : "▸"} {settled.length} settled</T></Pressable> : null}
        {showSettled ? settled.map(row) : null}
      </>}
    </View>
  );
}

function ChatRow({ chat, agents, waiting, here, nameOf, imageOf, me, report }: { chat: Doc<"chats">; agents: Doc<"agents">[]; waiting: boolean; here: string[]; nameOf: (l: string) => string; imageOf: (l: string) => string | null; me: string; report: (id: string, s: Counts[string]) => void }) {
  const runs = useQuery(api.runs.forChat, { chatId: chat._id });
  const labelled = (runs ?? []).map((r) => ({ ...r, label: agentName(agents.find((a) => a._id === r.agentId)?.harness ?? "claude", ownerOf(r), me, nameOf) }));
  const s = chatStatus(labelled, waiting);
  const now = useNow(s.state === "working");
  useEffect(() => { if (runs) report(chat._id, s.state); }, [runs, s.state, chat._id, report]);
  const settled = chat.state === "settled";
  const sq = s.state === "waiting" ? "warn" : s.state === "working" ? "work" : s.state === "failed" ? "bad" : "idle";
  return (
    <Row onPress={() => router.push({ pathname: "/chat/[id]", params: { id: chat._id } })} style={{ paddingLeft: space.padX + 10 }}>
      <Sq state={sq} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {chat.private ? <Icon name="lock" size={12} /> : null}
          <T weight={settled ? "regular" : "medium"} tone={settled || chat.untitled ? "ink3" : "ink"} italic={chat.untitled} lines={1} style={{ flexShrink: 1 }}>{chat.title}</T>
        </View>
        {s.state === "waiting" ? <T mono size={11} tone="warn" lines={1}>{s.agent} is waiting on you</T>
          : s.state === "working" ? <T mono size={11} tone="live" lines={1}>{s.agent} working · {elapsed(now - (s.since ?? now))}</T>
          : s.state === "failed" ? <T mono size={11} tone="bad" lines={1}>{s.agent} couldn't finish</T> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 5 }}>
        <T mono size={11} tone="ink3">{ago(chat.lastMessageAt)}</T>
        {here.length ? <Stack size={16}>{here.slice(0, 3).map((l) => <Avatar key={l} login={l} name={nameOf(l)} image={imageOf(l)} size={16} />)}</Stack> : null}
      </View>
    </Row>
  );
}

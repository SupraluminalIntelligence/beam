import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { landingOf, useChat } from "../../../chat/model";
import { isLive } from "../../../lib/agents";
import { api, type Id } from "../../../lib/convex";
import { radius, space, useTheme } from "../../../lib/theme";
import { Icon, Label, Row, Sq, T, TopBar } from "../../../ui";
import { Screen } from "../../../ui/Screen";

/** The chat's work: the code on GitHub, the machines holding a worktree, what changed, then chat settings. */
export default function Details() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = id as Id<"chats">;
  const t = useTheme();
  const c = useChat(chatId);
  const muted = useQuery(api.notifications.muted, { chatId });
  const setMuted = useMutation(api.notifications.setMuted);
  const setState = useMutation(api.chats.setState);
  const rename = useMutation(api.chats.rename);
  if (!c.chat) return <Screen><TopBar title="" onBack={() => router.back()} /></Screen>;
  const chat = c.chat;
  const repo = chat.repos?.[0] ?? chat.repo ?? c.detail?.repos[0] ?? null;
  const pr = c.open;
  const prUrl = pr?.prUrl ?? [...(c.runs ?? [])].reverse().flatMap((r) => landingOf(r).repos).find((x) => x.prUrl)?.prUrl ?? null;
  const open = (url: string) => void Linking.openURL(url);
  const settle = () => { void setState({ chatId, state: chat.state === "settled" ? "open" : "settled" }); if (chat.state !== "settled") router.dismissTo("/"); };
  const doRename = () => {
    if (Platform.OS === "ios") Alert.prompt("Rename chat", undefined, (v) => { if (v?.trim()) void rename({ chatId, title: v.trim() }); }, "plain-text", chat.title);
    else { const v = typeof window !== "undefined" ? window.prompt("Rename chat", chat.title) : null; if (v?.trim()) void rename({ chatId, title: v.trim() }); }
  };
  const machines = [...c.machines].sort((a, b) => (a.owner === c.login ? 0 : 1) - (b.owner === c.login ? 0 : 1));
  const split = (p: string) => { const i = p.lastIndexOf("/"); return [p.slice(i + 1), i > 0 ? p.slice(0, i) : ""] as const; };
  const files = [...c.files.filter((f) => !f.pushed), ...c.files.filter((f) => f.pushed)];
  return (
    <Screen>
      <TopBar nameCase title={chat.title} sub={`${c.detail?.name ?? ""}${chat.private ? " · private" : ""}`} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Label>Code</Label>
        <Pressable disabled={!repo} onPress={() => repo && open(prUrl ?? `https://github.com/${repo}${c.branch ? `/tree/${c.branch}` : ""}`)} style={({ pressed }) => ({ marginHorizontal: space.padX, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1, borderColor: t.line2, borderRadius: radius.object, backgroundColor: pressed ? t.surface2 : t.surface })}>
          <View style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.line2, borderRadius: radius.control, backgroundColor: t.surface2 }}><Icon name="github" size={19} /></View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <T mono weight="semi" size={13} lines={1}>{repo ?? "No repo yet"}</T>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name="branch" size={13} color={t.ink3} /><T mono size={11} tone="ink3" lines={1} style={{ flex: 1 }}>{c.branch ?? "no branch until an agent is dispatched"}</T></View>
            {pr ? <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name="pr" size={13} color={t.ink3} /><T mono size={11} tone="ink3">{pr.prNumber ? `PR #${pr.prNumber} ${pr.state}` : "open change"} · <T mono size={11} tone="add">+{pr.add}</T> <T mono size={11} tone="del">−{pr.del}</T></T></View> : null}
          </View>
          {repo ? <Icon name="external" size={17} /> : null}
        </Pressable>

        {machines.length ? (
          <View style={{ marginLeft: space.padX + 17, marginRight: space.padX }}>
            {machines.map((m, i) => {
              const last = i === machines.length - 1;
              const liveRun = m.runs.find((r) => isLive(r.state));
              const waiting = liveRun && (c.views[liveRun._id]?.requests.length ?? 0) > 0;
              const dirty = c.files.filter((f) => f.run.runnerId === m.id && !f.pushed).length;
              return (
                <View key={m.id} style={{ paddingTop: 14, paddingLeft: 24 }}>
                  <View style={{ position: "absolute", left: 0, top: 0, bottom: last ? undefined : 0, height: last ? 43 : undefined, width: StyleSheet.hairlineWidth, backgroundColor: t.line2 }} />
                  <View style={{ position: "absolute", left: 0, top: 43, width: 24, height: StyleSheet.hairlineWidth, backgroundColor: t.line2 }} />
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1, borderColor: t.line2, borderRadius: radius.object, backgroundColor: t.surface }}>
                    <View style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: t.line2, borderRadius: radius.control, backgroundColor: t.surface2 }}><Icon name="laptop" size={19} /></View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <T mono weight="semi" size={13} lines={1}>{m.name}</T>
                      <T mono size={11} tone="ink3">{m.owner === c.login ? "yours" : `${c.nameOf(m.owner).split(" ")[0]}'s`} · {m.online ? "online" : "offline"}</T>
                      {liveRun ? <T mono size={11} tone={waiting ? "warn" : "live"}>{c.nameOfRun(liveRun)} {waiting ? "is waiting on you" : "is working here"}</T>
                        : <T mono size={11} tone="ink3">{dirty ? `${dirty} unpushed change${dirty === 1 ? "" : "s"}` : "worktree clean"}</T>}
                    </View>
                    <Sq state={m.online ? "ok" : "idle"} />
                  </View>
                </View>
              );
            })}
            <T mono size={10.5} tone="ink3" style={{ marginTop: 10, marginLeft: 0 }}>each machine keeps its own worktree of the branch</T>
          </View>
        ) : null}

        {files.length ? <>
          <Label right={<T mono size={11} tone="ink2">{files.length}</T>}>Changes</Label>
          {files.map((f) => { const [name, dir] = split(f.path); return (
            <Row key={f.path} disabled>
              <Sq state={f.pushed ? "ok" : "idle"} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T mono weight="medium" size={13} lines={1}>{name}</T>
                <T mono size={11} tone="ink3" lines={1}>{dir ? `${dir} · ` : ""}{c.nameOfRun(f.run).toLowerCase()}</T>
              </View>
              <T mono size={11} tone="ink3">{f.pushed ? "pushed" : "in worktree"}</T>
            </Row>
          ); })}
        </> : null}

        <Label>Chat</Label>
        <Row onPress={doRename}><T style={{ flex: 1 }}>Rename</T></Row>
        <Row onPress={() => void setMuted({ chatId, muted: !muted })}><T style={{ flex: 1 }}>Mute notifications</T><Switch value={!!muted} onValueChange={(v) => void setMuted({ chatId, muted: v })} trackColor={{ true: t.ink, false: t.line2 }} thumbColor={t.surface} /></Row>
        <Row onPress={settle}><View style={{ flex: 1, gap: 2 }}><T>{chat.state === "settled" ? "Reopen" : "Settle"}</T><T mono size={11} tone="ink3">{chat.state === "settled" ? "back into the list" : "folds under settled; branch and history stay"}</T></View></Row>
      </ScrollView>
    </Screen>
  );
}

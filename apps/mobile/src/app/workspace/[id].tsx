import { useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { HARNESS } from "../../lib/agents";
import { api, type Id } from "../../lib/convex";
import { ago } from "../../lib/format";
import { useMe, usePeople } from "../../lib/hooks";
import { space, useTheme } from "../../lib/theme";
import { AgentMark, Avatar, Icon, Label, Row, Sq, T, Tile, TopBar } from "../../ui";
import { Screen } from "../../ui/Screen";

/** One workspace: repos, people and where they are, agents, machines, chats. The counts live here, not on home. */
export default function Workspace() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const workspaceId = id as Id<"workspaces">;
  const t = useTheme();
  const me = useMe();
  const detail = useQuery(api.workspaces.detail, { workspaceId });
  const chats = useQuery(api.chats.list, { workspaceId });
  const presence = useQuery(api.presence.inWorkspace, { workspaceId });
  const machines = useQuery(api.runners.online, { workspaceId });
  const { nameOf, imageOf } = usePeople(detail?.members ?? []);
  if (!detail) return <Screen><TopBar title="" onBack={() => router.back()} /></Screen>;
  const where = (l: string) => { const p = (presence ?? []).find((x) => x.login === l); const c = p?.chatId ? chats?.find((x) => x._id === p.chatId) : null; return c ? `in ${c.title}` : p ? "online" : "away"; };
  const open = (chats ?? []).filter((c) => !c.state || c.state === "open");
  return (
    <Screen>
      <TopBar onBack={() => router.back()} title={<View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Tile name={detail.name} size={26} /><T display weight="semi" size={19} lines={1}>{detail.name}</T></View>} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Label>Repos</Label>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.padX }}>
          {detail.repos.map((r) => <View key={r} style={{ borderWidth: 1, borderColor: t.line2, backgroundColor: t.surface2, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 2 }}><T mono size={11} tone="ink2">{r}</T></View>)}
        </View>
        <Label>People</Label>
        {detail.members.map((l) => (
          <Row key={l} disabled>
            <Avatar login={l} name={nameOf(l)} image={imageOf(l)} size={28} />
            <View style={{ flex: 1, gap: 2 }}><T weight="medium">{nameOf(l)}{l === me?.githubLogin ? <T mono size={11} tone="ink3">  you</T> : null}</T><T mono size={11} tone="ink3" lines={1}>{l === me?.githubLogin ? "here" : where(l)}</T></View>
            <Sq state={l === me?.githubLogin || where(l) !== "away" ? "ok" : "idle"} />
          </Row>
        ))}
        <Label>Agents</Label>
        {detail.agents.map((a) => (
          <Row key={a._id} disabled>
            <AgentMark harness={a.harness} size={28} />
            <View style={{ flex: 1, gap: 2 }}><T weight="medium">{HARNESS[a.harness]?.name ?? a.handle} <T mono size={11} tone="ink3">@{a.handle}</T></T><T mono size={11} tone="ink3">{a.model} · {a.effort} · {a.permissionMode}</T></View>
          </Row>
        ))}
        <Label>Machines online</Label>
        {(machines ?? []).length ? (machines ?? []).map((m) => (
          <Row key={String(m.id)} disabled>
            <Icon name="laptop" size={20} />
            <View style={{ flex: 1, gap: 2 }}><T mono weight="semi" size={13}>{m.name}</T><T mono size={11} tone="ink3">{m.ownerLogin === me?.githubLogin ? "yours" : `${nameOf(m.ownerLogin).split(" ")[0]}'s`}{m.allowSharedRuns ? " · shared runs allowed" : ""}</T></View>
            <Sq state="ok" />
          </Row>
        )) : <T size={14} tone="ink3" style={{ paddingHorizontal: space.padX }}>No machine is online. Agents run when someone's machine is.</T>}
        <Label>Chats</Label>
        {open.map((c) => (
          <Row key={c._id} onPress={() => router.push({ pathname: "/chat/[id]", params: { id: c._id } })}>
            <View style={{ flex: 1, minWidth: 0 }}><T weight="medium" lines={1} italic={c.untitled} tone={c.untitled ? "ink3" : "ink"}>{c.title}</T></View>
            <T mono size={11} tone="ink3">{ago(c.lastMessageAt)}</T>
          </Row>
        ))}
      </ScrollView>
    </Screen>
  );
}

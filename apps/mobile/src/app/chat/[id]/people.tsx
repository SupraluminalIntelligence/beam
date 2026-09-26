import { useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, View } from "react-native";
import { useChat } from "../../../chat/model";
import { isLive } from "../../../lib/agents";
import { api, type Id } from "../../../lib/convex";
import { useTheme } from "../../../lib/theme";
import { AgentMark, Avatar, Label, Row, Sq, T } from "../../../ui";

/** "In this chat": the people, then the agents, each agent named by whose account it runs on. */
export default function People() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useChat(id as Id<"chats">);
  const t = useTheme();
  const presence = useQuery(api.presence.inWorkspace, c.chat ? { workspaceId: c.chat.workspaceId } : "skip");
  if (!c.chat || !c.detail) return <View style={{ flex: 1, backgroundColor: t.surface }} />;
  const members = c.chat.private ? [c.login] : c.detail.members;
  const where = (l: string) => { const p = (presence ?? []).find((x) => x.login === l); if (!p?.chatId) return "away"; if (p.chatId === c.chat!._id) return "here now"; return "in another chat"; };
  return (
    <ScrollView style={{ backgroundColor: t.surface }} contentContainerStyle={{ paddingTop: 18, paddingBottom: 40 }}>
      <View style={{ paddingHorizontal: 20, gap: 4 }}>
        <T display weight="semi" size={20}>In this chat</T>
        <T size={14} tone="ink2">{c.chat.private ? "Private. Only you and your agents." : `Everyone in ${c.detail.name} can read and write here.`}</T>
      </View>
      <Label>People</Label>
      {members.map((l) => (
        <Row key={l} disabled>
          <Avatar login={l} name={c.nameOf(l)} image={c.imageOf(l)} size={28} />
          <View style={{ flex: 1, gap: 2 }}>
            <T weight="medium">{c.nameOf(l)}{l === c.login ? <T mono size={11} tone="ink3">  you</T> : null}</T>
            <T mono size={11} tone="ink3">{l === c.login ? "here now" : where(l)}</T>
          </View>
          <Sq state={l === c.login || where(l) === "here now" ? "ok" : "idle"} />
        </Row>
      ))}
      <Label>Agents</Label>
      {c.crew.length ? c.crew.map((a) => {
        const view = c.views[a.run._id];
        const state = isLive(a.run.state) ? ((view?.requests.length ?? 0) > 0 ? "waiting on you" : "working") : a.run.state === "failed" ? "failed" : a.run.state === "interrupted" ? "stopped" : "idle";
        const tone = state === "waiting on you" ? "warn" : state === "working" ? "live" : state === "failed" || state === "stopped" ? "bad" : "ink2";
        const ex = a.run.execution;
        return (
          <Row key={`${a.harness}:${a.owner}`} disabled={a.owner !== c.login} onPress={() => router.push({ pathname: "/chat/[id]/agent", params: { id: c.chat!._id, harness: a.harness } })}>
            <AgentMark harness={a.harness} size={28} />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T weight="medium">{a.name}</T>
              <T mono size={11} tone="ink3" lines={2}>{ex ? `${ex.modelName ?? ex.model} · ${ex.effort} · ` : ""}on {a.run.runnerName}</T>
            </View>
            <View style={{ alignItems: "flex-end", gap: 4 }}>
              <T mono size={11} tone={tone}>{state}</T>
              {a.owner === c.login ? <T mono size={10.5} tone="ink3">settings ›</T> : null}
            </View>
          </Row>
        );
      }) : <T size={14} tone="ink3" style={{ paddingHorizontal: 20 }}>No agents yet. Mention one in the chat to bring it in.</T>}
      <T mono size={11} tone="ink3" style={{ paddingHorizontal: 20, paddingTop: 16 }} >Tap a message's composer and type @ to bring in an agent.</T>
      <View style={{ height: 12 }} />
      <Row onPress={() => router.back()} style={{ justifyContent: "center", borderTopWidth: 0 }}><T mono size={13} tone="ink2">Close</T></Row>
    </ScrollView>
  );
}

import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { api, type Doc } from "../../lib/convex";
import { ago } from "../../lib/format";
import { space, useTheme } from "../../lib/theme";
import { Empty, Label, Sq, T, TopBar } from "../../ui";
import { Screen } from "../../ui/Screen";

const FILTERS = [["all", "All"], ["needs", "Needs you"], ["mention", "Mentions"], ["runs", "Runs"]] as const;
type Filter = (typeof FILTERS)[number][0];
const match: Record<Filter, (n: Doc<"notifications">) => boolean> = {
  all: () => true, needs: (n) => n.kind === "input" && n.readAt === null, mention: (n) => (n.kind as string) === "mention", runs: (n) => n.kind === "completed" || n.kind === "failed",
};

/** Everything that happened while you were away, newest first. Needs-you comes first in the filters. */
export default function Inbox() {
  const t = useTheme();
  const rows = useQuery(api.notifications.inbox);
  const read = useMutation(api.notifications.read);
  const [filter, setFilter] = useState<Filter>("all");
  const items = (rows ?? []).filter(match[filter]);
  const count = (f: Filter) => (rows ?? []).filter(match[f]).filter((n) => f !== "all" || n.readAt === null).length;
  const today = items.filter((n) => Date.now() - n._creationTime < 86_400_000), earlier = items.filter((n) => Date.now() - n._creationTime >= 86_400_000);
  const row = (n: Doc<"notifications">) => (
    <Pressable key={n._id} onPress={() => { void read({ id: n._id }); router.push({ pathname: "/chat/[id]", params: { id: n.chatId } }); }} style={({ pressed }) => ({ flexDirection: "row", gap: 12, paddingHorizontal: space.padX, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, backgroundColor: pressed ? t.surface2 : "transparent" })}>
      <View style={{ paddingTop: 6 }}><Sq state={n.kind === "input" && n.readAt === null ? "warn" : n.kind === "failed" ? "bad" : n.kind === "completed" ? "ok" : "idle"} /></View>
      <View style={{ flex: 1, gap: 3 }}>
        <T weight={n.readAt === null ? "semi" : "medium"} tone={n.readAt === null ? "ink" : "ink2"}>{n.title}</T>
        <T size={14} tone="ink2">{n.body}</T>
      </View>
      <View style={{ alignItems: "flex-end", gap: 8, paddingTop: 2 }}>
        <T mono size={11} tone="ink3">{ago(n._creationTime)}</T>
        {n.readAt === null ? <View style={{ width: 7, height: 7, backgroundColor: t.ink }} /> : null}
      </View>
    </Pressable>
  );
  return (
    <Screen>
      <TopBar big title="Inbox" right={<Pressable onPress={() => (rows ?? []).filter((n) => n.readAt === null).forEach((n) => void read({ id: n._id }))} style={{ height: 40, justifyContent: "center", paddingHorizontal: 10 }}><T mono size={11} tone="ink3">Mark all read</T></Pressable>} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }} contentContainerStyle={{ gap: 6, paddingHorizontal: space.padX, paddingVertical: 10 }}>
        {FILTERS.map(([k, label]) => { const on = filter === k, n = k === "runs" ? 0 : count(k); return (
          <Pressable key={k} onPress={() => setFilter(k)} style={{ height: 32, paddingHorizontal: 12, borderWidth: 1, borderColor: on ? t.ink : t.line2, backgroundColor: on ? t.ink : "transparent", borderRadius: 2, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <T mono size={12} tone={on ? "surface" : "ink2"}>{label}</T>{n ? <T mono size={11} tone={on ? "surface" : "ink3"}>{n}</T> : null}
          </Pressable>
        ); })}
      </ScrollView>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {today.length ? <><Label>Today</Label>{today.map(row)}</> : null}
        {earlier.length ? <><Label>Earlier</Label>{earlier.map(row)}</> : null}
        {rows && !items.length ? <Empty title={filter === "needs" ? "Nothing is waiting on you." : "Nothing here."}>{filter === "needs" ? "When an agent stops to ask, it lands here." : "Mentions and runs in chats you follow show up here."}</Empty> : null}
      </ScrollView>
    </Screen>
  );
}

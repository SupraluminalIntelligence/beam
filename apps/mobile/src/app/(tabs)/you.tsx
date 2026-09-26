import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { ScrollView, Switch, View } from "react-native";
import { HARNESS } from "../../lib/agents";
import { api } from "../../lib/convex";
import { ago } from "../../lib/format";
import { useMe } from "../../lib/hooks";
import { space, useTheme } from "../../lib/theme";
import { Avatar, Icon, Label, Row, Sq, T, TopBar } from "../../ui";
import { Screen } from "../../ui/Screen";

type Harness = { harness: string; installed: boolean; auth: string };
const PREFS = [["enabled", "Notifications", "master switch"], ["input", "Agent needs you", "approvals and questions"], ["completed", "Work landed", ""], ["failed", "Work failed or stopped", ""], ["mention", "Mentions", ""], ["sound", "Sound", ""]] as const;

/** You: your machines, notifications, account. */
export default function You() {
  const t = useTheme();
  const me = useMe();
  const machines = useQuery(api.runners.mine);
  const prefs = useQuery(api.notifications.preferences);
  const setPrefs = useMutation(api.notifications.setPreferences);
  const workspaces = useQuery(api.workspaces.mine);
  const { signOut } = useAuthActions();
  return (
    <Screen>
      <TopBar big title="You" />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {me ? <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: space.padX, paddingTop: 22, paddingBottom: 8 }}>
          <Avatar login={me.githubLogin} name={me.name} image={me.image} size={48} />
          <View style={{ gap: 2 }}><T display weight="semi" size={20}>{me.name}</T><T mono size={11} tone="ink3">@{me.githubLogin} · GitHub · {workspaces?.length ?? 0} workspace{workspaces?.length === 1 ? "" : "s"}</T></View>
        </View> : null}
        <Label>Your machines</Label>
        {(machines ?? []).map((m) => {
          const hs = ((m.harnesses as Harness[] | null) ?? []).filter((h) => h.installed);
          return (
            <Row key={String(m.id)} disabled style={{ alignItems: "flex-start", paddingVertical: 12 }}>
              <View style={{ paddingTop: 6 }}><Sq state={m.online ? "ok" : "idle"} /></View>
              <View style={{ flex: 1, gap: 3 }}>
                <T mono weight="semi" size={13}>{m.name}</T>
                <T mono size={11} tone="ink3">{m.launchedByApp ? "launched by Beam" : "standalone"}{m.allowSharedRuns ? " · teammates can run here" : ""}</T>
                {hs.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 4 }}>{hs.map((h) => <View key={h.harness} style={{ borderWidth: 1, borderColor: t.line2, backgroundColor: t.surface2, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 2 }}><T mono size={11} tone="ink2">{HARNESS[h.harness]?.name ?? h.harness}{h.auth === "authenticated" ? "" : " · signed out"}</T></View>)}</View> : null}
              </View>
              <T mono size={11} tone={m.online ? "ink2" : "ink3"}>{m.online ? "online" : ago(m.lastSeen)}</T>
            </Row>
          );
        })}
        {machines && !machines.length ? <T size={14} tone="ink3" style={{ paddingHorizontal: space.padX }}>No machines yet. Open Beam on your Mac, or run beam-runner login on a server.</T> : null}
        <Label>Notifications</Label>
        {prefs ? PREFS.filter(([k]) => k in prefs).map(([k, label, sub]) => (
          <Row key={k} onPress={() => void setPrefs({ preferences: { ...prefs, [k]: !prefs[k as keyof typeof prefs] } })}>
            <View style={{ flex: 1, gap: 2 }}><T>{label}</T>{sub ? <T mono size={11} tone="ink3">{sub}</T> : null}</View>
            <Switch value={!!prefs[k as keyof typeof prefs]} onValueChange={(v) => void setPrefs({ preferences: { ...prefs, [k]: v } })} trackColor={{ true: t.ink, false: t.line2 }} thumbColor={t.surface} />
          </Row>
        )) : null}
        <T mono size={11} tone="ink3" style={{ paddingHorizontal: space.padX, paddingTop: 10 }}>Push to this phone arrives in the next build. Until then the inbox holds everything.</T>
        <Label>Account</Label>
        <Row onPress={() => void signOut()}><Icon name="you" size={18} color={t.bad} /><T tone="bad">Log out</T></Row>
      </ScrollView>
    </Screen>
  );
}

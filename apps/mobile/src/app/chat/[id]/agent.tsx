import { HARNESS_INFO } from "@beam/contracts";
import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { EFFORT_ORDER, effortLevel, HARNESS, PERMISSION_MODES } from "../../../lib/agents";
import { errorText } from "../../../lib/format";
import { api, type Id } from "../../../lib/convex";
import { useMe } from "../../../lib/hooks";
import { radius, space, useTheme } from "../../../lib/theme";
import { AgentMark, Icon, Label, Sq, T } from "../../../ui";

type Model = { model: string; name: string; efforts: string[] };
type Status = { harness: string; connectionId?: string; isDefault?: boolean; models?: Model[] };

/**
 * One agent, as you run it in this chat. Model and effort are yours; the machine and account are yours for
 * this chat; permissions belong to the workspace agent and change it for everyone.
 */
export default function AgentSheet() {
  const { id, harness } = useLocalSearchParams<{ id: string; harness: string }>();
  const chatId = id as Id<"chats">;
  const t = useTheme();
  const me = useMe();
  const chat = useQuery(api.chats.get, { chatId });
  const detail = useQuery(api.workspaces.detail, chat ? { workspaceId: chat.workspaceId } : "skip");
  const prefs = useQuery(api.users.preferences);
  const preview = useQuery(api.connections.preview, { chatId, harness });
  const online = useQuery(api.runners.online, chat ? { workspaceId: chat.workspaceId } : "skip");
  const savePref = useMutation(api.users.setAgentPreference);
  const setConnection = useMutation(api.connections.setPreference);
  const updateAgent = useMutation(api.workspaces.updateAgent);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = detail?.agents.find((a) => a.harness === harness);
  if (!chat || !detail || !agent || prefs === undefined) return <View style={{ flex: 1, backgroundColor: t.surface }} />;

  const pref = prefs.find((p) => p.harness === harness);
  const model = pref?.model ?? agent.model;
  const effort = pref?.effort ?? agent.effort;
  const selected = preview?.selected ?? null;
  const runner = (online ?? []).find((r) => String(r.id) === String(selected?.runnerId));
  const status = ((runner?.harnesses as Status[] | null) ?? []).find((s) => s.harness === harness && (s.connectionId ?? "default") === (selected?.connectionId ?? "default"));
  const catalog: Model[] = harness === "codex" && status?.models?.length ? status.models : (HARNESS_INFO[harness]?.models ?? []).map((m) => ({ model: m, name: m, efforts: ["low", "medium", "high", "max"] }));
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
  const current = catalog.find((m) => norm(m.model) === norm(model) || norm(m.name) === norm(model));
  const supported = EFFORT_ORDER.filter((e) => (current?.efforts ?? ["low", "medium", "high", "max"]).includes(e) || e === "max");
  const keep = pref?.runnerId ? { runnerId: pref.runnerId, ...(pref.connectionId ? { connectionId: pref.connectionId } : {}) } : {};

  async function run(key: string, fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); }
    setBusy(null);
  }
  const chooseModel = (m: Model) => run(`model:${m.model}`, () => savePref({ harness, model: m.model, effort: m.efforts.includes(effort) || effort === "max" ? effort : m.efforts.includes("medium") ? "medium" : m.efforts[0] ?? "max", ...keep }));
  const chooseEffort = (e: string) => run(`effort:${e}`, () => savePref({ harness, model: current?.model ?? model, effort: e, ...keep }));
  const choose = (runnerId: string, connectionId: string) => run(`conn:${runnerId}:${connectionId}`, () => setConnection({ harness, chatId, runnerId: runnerId as Id<"runners">, connectionId }));
  const useDefault = () => run("conn:default", () => setConnection({ harness, chatId }));
  const choosePermission = (v: string) => run(`perm:${v}`, () => updateAgent({ agentId: agent._id, patch: { permissionMode: v } }));

  const option = (key: string, on: boolean, body: React.ReactNode, onPress: () => void, disabled = false) => (
    <Pressable key={key} disabled={disabled || !!busy} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 54, paddingHorizontal: space.padX, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line, backgroundColor: pressed ? t.surface2 : "transparent", opacity: disabled ? 0.45 : busy === key ? 0.5 : 1 })}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>{body}</View>
      <T mono size={13}>{on ? "✓" : ""}</T>
    </Pressable>
  );
  const mine = (preview?.options ?? []).filter((o) => o.owner === me?.githubLogin);
  const theirs = (preview?.options ?? []).filter((o) => o.owner !== me?.githubLogin);
  const isSel = (o: { runnerId: unknown; connectionId: string }) => String(o.runnerId) === String(selected?.runnerId) && o.connectionId === selected?.connectionId;
  const connRow = (o: NonNullable<typeof preview>["options"][number]) => option(`conn:${o.runnerId}:${o.connectionId}`, isSel(o), <>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Sq state={o.online && o.authenticated ? "ok" : "idle"} /><T mono weight="semi" size={13} lines={1}>{o.machineName}</T></View>
    <T mono size={11} tone="ink3" lines={1}>{o.owner === me?.githubLogin ? "" : `${o.owner}'s · `}{o.name}{o.email ? ` · ${o.email}` : ""}{!o.online ? " · offline" : !o.authenticated ? " · signed out" : ""}</T>
  </>, () => void choose(String(o.runnerId), o.connectionId), !o.online || !o.authenticated);

  return (
    <ScrollView style={{ backgroundColor: t.surface }} contentContainerStyle={{ paddingTop: 18, paddingBottom: 40 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.padX }}>
        <AgentMark harness={harness} size={30} />
        <View style={{ flex: 1 }}>
          <T display weight="semi" size={20}>{`Your ${HARNESS[harness]?.name ?? harness}`}</T>
          <T mono size={11} tone="ink3">@{agent.handle} · {detail.name} · applies to your next run</T>
        </View>
      </View>
      {error ? <T mono size={12} tone="bad" style={{ paddingHorizontal: space.padX, paddingTop: 10 }}>{error}</T> : null}

      <Label>Runs on</Label>
      {preview === undefined ? null : <>
        {selected ? <T size={14} tone="ink2" style={{ paddingHorizontal: space.padX, paddingBottom: 8 }}>This chat runs on <T size={14} weight="medium">{selected.machineName}</T>{selected.name ? ` with ${selected.name}` : ""}{preview.override ? ", picked for this chat." : ", your default."}</T>
          : <T size={14} tone="warn" style={{ paddingHorizontal: space.padX, paddingBottom: 8 }}>{preview.error ?? "No machine can run this agent right now."}</T>}
        {mine.map(connRow)}
        {theirs.length ? <><Label style={{ paddingTop: 14 }}>Teammates' machines</Label>{theirs.map(connRow)}</> : null}
        {preview.override ? option("conn:default", false, <><T>Use my default</T><T mono size={11} tone="ink3">whatever you picked on your desktop</T></>, () => void useDefault()) : null}
      </>}

      <Label>Model</Label>
      {catalog.map((m) => option(`model:${m.model}`, current?.model === m.model, <T>{m.name}</T>, () => void chooseModel(m)))}
      {!current && model ? <T mono size={11} tone="ink3" style={{ paddingHorizontal: space.padX, paddingTop: 8 }}>current: {model}</T> : null}

      <Label>Effort</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.padX }}>
        {supported.map((e) => {
          const on = e === effort, lv = effortLevel(e, supported);
          return (
            <Pressable key={e} disabled={!!busy} onPress={() => void chooseEffort(e)} style={{ minWidth: 72, height: 58, alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1, borderColor: on ? t.ink : t.line2, backgroundColor: on ? t.surface2 : "transparent", borderRadius: radius.control }}>
              <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 10 }}>{[3, 5, 7, 10].map((h, i) => <View key={i} style={{ width: 3, height: h, backgroundColor: i < lv ? t.ink2 : t.line2 }} />)}</View>
              <T mono size={11} tone={on ? "ink" : "ink2"}>{e}</T>
            </Pressable>
          );
        })}
      </View>

      <Label>Permissions · shared</Label>
      <T size={13} tone="ink3" style={{ paddingHorizontal: space.padX, paddingBottom: 6 }}>This changes @{agent.handle} for everyone in {detail.name}.</T>
      {PERMISSION_MODES.map((m) => option(`perm:${m.v}`, agent.permissionMode === m.v, <><T>{m.label}</T><T mono size={11} tone="ink3">{m.hint}</T></>, () => void choosePermission(m.v)))}

      <Pressable onPress={() => router.back()} style={{ marginTop: 24, minHeight: 48, alignItems: "center", justifyContent: "center" }}><T mono size={13} tone="ink2">Done</T></Pressable>
    </ScrollView>
  );
}

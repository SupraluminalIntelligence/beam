import { useMutation, useQuery } from "convex/react";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { formatQuantity } from "@beam/contracts";
import { api, type Id } from "../lib/convex";
import { errorText } from "../lib/format";
import { radius, useTheme } from "../lib/theme";
import { Sq, T, type SqState } from "../ui";

const SQ: Record<string, SqState> = { succeeded: "ok", failed: "bad", cancelled: "off", "awaiting-approval": "warn", queued: "idle", preparing: "work", running: "work", publishing: "work" };
type Q = { name: string; label: string; value: number; unit: string; uncertainty?: { kind: string; relative?: number | undefined; absolute?: number | undefined } | undefined };
const text = (q: Q) => `${formatQuantity(q.value, q.unit)}${q.uncertainty?.relative !== undefined ? ` ±${Number((q.uncertainty.relative * 100).toPrecision(2))}%` : ""}`;

/**
 * A simulation's card on the phone: what its latest job is doing, its headline numbers and the checks
 * that need a person, and Approve when that job is waiting on you. Plots and 3D stay on the desktop.
 */
export function SimulationCard({ id, me }: { id: Id<"simulationCases">; me: string }) {
  const t = useTheme();
  const sim = useQuery(api.simulations.get, { id });
  const approve = useMutation(api.compute.approve);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  if (sim === undefined) return <View style={[styles.card, { borderColor: t.line2, backgroundColor: t.surface }]}><T mono size={11} tone="ink3">Loading simulation…</T></View>;
  if (!sim) return <View style={[styles.card, { borderColor: t.line2, backgroundColor: t.surface }]}><T mono size={11} tone="ink3">Simulation unavailable</T></View>;
  const latest = sim.jobs[0], done = sim.jobs.find((j) => j.state === "succeeded" && j.results);
  const waiting = latest?.state === "awaiting-approval" && latest.requestedBy === me ? latest : null;
  const status = latest ? `v${latest.version} · ${latest.state.replaceAll("-", " ")}` : `v${sim.version} saved · not run yet`;
  return (
    <View style={[styles.card, { borderColor: waiting ? t.warn : t.line2, backgroundColor: t.surface }]} accessibilityLabel={`Simulation ${sim.name}, ${status}`}>
      <View style={styles.row}>
        <Sq state={SQ[latest?.state ?? ""] ?? "idle"} size={8} />
        <T weight="medium" size={14} lines={1} style={{ flex: 1 }}>{sim.name}</T>
        <T mono size={11} tone="ink3">v{sim.version}</T>
      </View>
      <T mono size={11} tone={latest && SQ[latest.state] === "work" ? "live" : "ink2"}>{status}</T>
      {done?.results ? <View style={{ gap: 2, marginTop: 4 }}>
        {done.results.headline.map((q) => <View key={q.name} style={[styles.q, { borderBottomColor: t.line }]}><T mono size={11.5} tone="ink3" lines={1} style={{ flexShrink: 1 }}>{q.label}</T><T mono size={11.5}>{text(q)}</T></View>)}
        <T mono size={11} tone="ink2" style={{ marginTop: 4 }}>✓ {done.results.checks.pass} pass{done.results.checks.review ? ` · ${done.results.checks.review} to review` : ""}{done.results.checks.fail ? ` · ${done.results.checks.fail} failed` : ""}{done.version !== latest?.version ? ` · from v${done.version}` : ""}</T>
        {done.results.flagged.map((c) => <T key={c.id} mono size={11} tone={c.status === "fail" ? "bad" : "warn"}>{c.status === "fail" ? "✕" : "!"} {c.label}{c.value ? ` · ${c.value}` : ""}</T>)}
      </View> : null}
      {waiting ? <View style={{ gap: 6, marginTop: 8 }}>
        <T size={13} tone="ink2">{waiting.title} is waiting for you to approve it{waiting.environment ? ` · ${waiting.environment} environment` : ""}.{waiting.resume ? ` Approving also lets @${waiting.resume.handle} continue when it ends: ${waiting.resume.note}` : ""}</T>
        <Pressable accessibilityRole="button" disabled={busy} onPress={async () => {
          setBusy(true); setError(null);
          try { await approve({ id: waiting._id }); if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }
          catch (e) { setError(errorText(e)); } finally { setBusy(false); }
        }} style={[styles.approve, { backgroundColor: t.ink, opacity: busy ? 0.5 : 1 }]}>
          <T mono caps size={11} style={{ color: t.surface, letterSpacing: 1.5 }}>Approve and run</T>
        </Pressable>
        {error ? <T size={12} tone="bad">{error}</T> : null}
      </View> : null}
      {done?.results ? <T size={11.5} tone="ink3" style={{ marginTop: 6 }}>Plots and 3D open on the desktop.</T> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.object, padding: 12, gap: 4, marginTop: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  q: { flexDirection: "row", justifyContent: "space-between", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 3 },
  approve: { minHeight: 44, borderRadius: radius.control, alignItems: "center", justifyContent: "center" },
});

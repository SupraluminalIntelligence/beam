import { useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { api, type Id } from "../../../lib/convex";
import { font, radius, useTheme } from "../../../lib/theme";
import { Empty, Icon, Row, T, TopBar } from "../../../ui";
import { Screen } from "../../../ui/Screen";

export { FileErrorBoundary as ErrorBoundary } from "../../../chat/Files";

/** Desktop's context catalog, with phone navigation and the same access checks. */
export default function ContextScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [scope, setScope] = useState<"chat" | "workspace">("chat");
  const [search, setSearch] = useState("");
  const rows = useQuery(api.files.context, { chatId: id as Id<"chats">, scope });
  const shown = rows?.filter((row) => row.title.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <Screen bottom>
      <TopBar title="Context" sub="Files, screenshots, links and notes" onBack={() => router.back()} />
      <View style={{ padding: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(["chat", "workspace"] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: scope === value }} onPress={() => { setScope(value); setSearch(""); }} style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: scope === value ? t.ink : t.line2, borderRadius: radius.control, backgroundColor: scope === value ? t.surface3 : t.surface }}><T mono size={12}>{value === "chat" ? "This chat" : "Workspace"}</T></Pressable>)}
        </View>
        <TextInput accessibilityLabel="Search context" placeholder="Find a file or source…" placeholderTextColor={t.ink3} value={search} onChangeText={setSearch} autoCorrect={false} style={{ minHeight: 44, borderWidth: 1, borderColor: t.line2, borderRadius: radius.control, paddingHorizontal: 12, fontFamily: font.sans, color: t.ink }} />
      </View>
      <FlatList data={shown ?? []} keyExtractor={(row) => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={<Empty title={rows === undefined ? "Loading context…" : search.trim() ? "No matching sources" : scope === "workspace" ? "No shared workspace sources" : "No files or sources yet"}>{rows !== undefined && !search.trim() && scope === "chat" ? "Files shared by people and agents appear here. Ask an agent to share a screenshot in Beam to view it on your phone." : undefined}</Empty>}
        renderItem={({ item: row }) => <Row accessibilityRole="button" accessibilityLabel={`Open ${row.title}`} onPress={() => {
          if (row.sourceId) router.push({ pathname: "/chat/[id]/source/[sourceId]", params: { id, sourceId: row.sourceId } });
          else if (row.fileId) router.push({ pathname: "/file/[id]", params: { id: row.fileId } });
        }}>
          <Icon name={row.kind === "link" ? "external" : "files"} />
          <View style={{ flex: 1, gap: 3 }}><T size={14} lines={2}>{row.title}</T><T mono size={10} tone="ink3">{row.kind}{row.size !== null ? ` · ${Math.max(1, Math.ceil(row.size / 1024))} KB` : ""} · {row.draft ? "Draft · only you" : row.shared ? "Shared with workspace" : "This chat"}</T></View>
          <Icon name="right" size={16} />
        </Row>} />
    </Screen>
  );
}

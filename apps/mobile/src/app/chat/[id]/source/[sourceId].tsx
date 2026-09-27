import { useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { DocumentPreview } from "../../../../chat/Files";
import { api, type Id } from "../../../../lib/convex";
import { Button, Empty, T, TopBar } from "../../../../ui";
import { Screen } from "../../../../ui/Screen";

export { FileErrorBoundary as ErrorBoundary } from "../../../../chat/Files";

export default function SourceScreen() {
  const { id, sourceId } = useLocalSearchParams<{ id: string; sourceId: string }>();
  const source = useQuery(api.files.sourcePreview, { chatId: id as Id<"chats">, id: sourceId as Id<"contextSources"> });
  const [error, setError] = useState<string | null>(null);
  if (source?.kind === "file") return <DocumentPreview key={sourceId} file={source.file} />;
  async function open() {
    if (!source?.url) return;
    try { setError(null); await Linking.openURL(source.url); }
    catch { setError("Could not open this link. Please try again."); }
  }
  return (
    <Screen bottom>
      <TopBar title={source?.title ?? "Source"} onBack={() => router.back()} />
      {!source ? <Empty title="Loading source…" /> : <ScrollView contentContainerStyle={{ padding: 16 }}>
        {source.kind === "link" ? <View style={{ gap: 16 }}><T selectable>{source.url}</T><T tone="ink3" size={13}>Link reference · page contents aren’t stored in Beam.</T><Button label="Open link" onPress={() => void open()} />{error ? <T tone="bad">{error}</T> : null}</View> : <T selectable>{source.content}</T>}
      </ScrollView>}
    </Screen>
  );
}

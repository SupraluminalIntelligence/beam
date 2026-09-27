import { useQuery } from "convex/react";
import { router, type ErrorBoundaryProps } from "expo-router";
import { useState } from "react";
import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import { api, type Id } from "../lib/convex";
import { radius, useTheme } from "../lib/theme";
import { Button, Empty, T, TopBar } from "../ui";
import { Screen } from "../ui/Screen";

type Preview = { name: string; mime: string; url: string | null; text?: string };
const isImage = (file: Preview) => /^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(file.mime) || /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(file.name);

/** Resolve attachments through the same authorized query as desktop, including agent-only file messages. */
export function MessageFiles({ ids }: { ids?: Id<"files">[] }) {
  if (!ids?.length) return null;
  return <View style={{ gap: 8, marginTop: 6 }}>{ids.map((id) => <Attachment key={id} id={id} />)}</View>;
}

function Attachment({ id }: { id: Id<"files"> }) {
  const file = useQuery(api.files.preview, { id });
  const t = useTheme();
  return (
    <Pressable disabled={!file} accessibilityRole="button" accessibilityLabel={file ? `Open ${file.name}` : file === undefined ? "Loading attachment" : "Attachment unavailable"}
      onPress={() => router.push({ pathname: "/file/[id]", params: { id } })}
      style={({ pressed }) => ({ borderWidth: 1, borderColor: t.line2, borderRadius: radius.object, overflow: "hidden", backgroundColor: pressed ? t.surface3 : t.surface2 })}>
      {file?.url && isImage(file) ? <Thumbnail key={file.url} uri={file.url} name={file.name} /> : null}
      <View style={{ padding: 10, gap: 3 }}>
        <T mono size={12} lines={2}>{file?.name ?? (file === undefined ? "Loading attachment…" : "Attachment unavailable")}</T>
        {file ? <T mono size={10} tone="ink3">{Math.max(1, Math.ceil(file.size / 1024))} KB · {isImage(file) ? "Tap to view image" : "Tap to open file"}</T> : null}
      </View>
    </Pressable>
  );
}

function Thumbnail({ uri, name }: { uri: string; name: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  return (
    <View style={{ height: 200 }}>
      <Image source={{ uri }} accessibilityLabel={name} resizeMode="contain" style={{ width: "100%", height: "100%" }}
        onLoad={() => setState("ready")} onError={() => setState("error")} />
      {state !== "ready" ? <View pointerEvents="none" style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
        <T mono size={11} tone="ink3">{state === "error" ? "Preview unavailable · tap to open" : "Loading image…"}</T>
      </View> : null}
    </View>
  );
}

/** Both chat attachments and shared context sources use this viewer. */
export function DocumentPreview({ file }: { file: Preview | null | undefined }) {
  const [error, setError] = useState<string | null>(null);
  async function open() {
    if (!file?.url) return;
    try { setError(null); await Linking.openURL(file.url); }
    catch { setError("Could not open the original. Please try again."); }
  }
  return (
    <Screen bottom>
      <TopBar title={file?.name ?? "File"} onBack={() => router.back()} right={file?.url ? (
        <Pressable accessibilityRole="button" onPress={() => void open()} style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: "center" }}><T mono size={11}>Open original</T></Pressable>
      ) : undefined} />
      {error ? <T tone="bad" size={13} style={{ padding: 16 }}>{error}</T> : null}
      {file === undefined ? <Empty title="Loading file…" /> : file === null ? <Empty title="File unavailable">It may have been removed or you may no longer have access.</Empty>
        : file.url && isImage(file) ? <ImageCanvas key={file.url} uri={file.url} name={file.name} />
        : file.text !== undefined ? <ScrollView contentContainerStyle={{ padding: 16 }}><T mono size={12} selectable>{file.text || "No text found in this document."}{file.text.length >= 200_000 ? "\n\nPreview truncated. Open the original for the full document." : ""}</T></ScrollView>
        : <Empty title={file.url ? "Open this file in another app" : "File unavailable"}>{file.url ? "Use Open original to view this document in your browser or a compatible app." : "The original file is no longer available."}</Empty>}
    </Screen>
  );
}

function ImageCanvas({ uri, name }: { uri: string; name: string }) {
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => { const { width, height } = e.nativeEvent.layout; setBounds({ width, height }); }}>
      {bounds.width > 0 && bounds.height > 0 ? <ScrollView key={attempt} style={{ flex: 1 }} maximumZoomScale={5} minimumZoomScale={1} centerContent bouncesZoom>
        <Image source={{ uri }} accessibilityLabel={name} resizeMode="contain" style={bounds} onLoad={() => { setLoaded(true); setFailed(false); }} onError={() => { setLoaded(false); setFailed(true); }} />
      </ScrollView> : null}
      {!loaded ? <View pointerEvents={failed ? "auto" : "none"} style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", gap: 12, padding: 20 }}>
        <T tone="ink2">{failed ? "Could not load this image." : "Loading image…"}</T>
        {failed ? <Button label="Retry image" onPress={() => { setFailed(false); setAttempt((n) => n + 1); }} /> : null}
      </View> : null}
    </View>
  );
}

export function FileErrorBoundary({ retry }: ErrorBoundaryProps) {
  return <Screen><TopBar title="File unavailable" onBack={() => router.back()} /><Empty title="Could not load this content">Check your connection and whether you still have access to the chat.</Empty><View style={{ paddingHorizontal: 16 }}><Button label="Try again" onPress={() => void retry()} /></View></Screen>;
}

import { Linking, Text, View } from "react-native";
import { font, radius, useTheme } from "../lib/theme";

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|@[a-z0-9-]+)/gi;

/** Markdown-lite for chat: fenced code, headings, lists, inline code, bold, links, @mentions. */
export function Rich({ text, size = 15, known }: { text: string; size?: number; known: Set<string> }) {
  const t = useTheme();
  const blocks = text.split(/```[a-z0-9-]*\n?/i);
  const lh = Math.round(size * 1.45);
  const inline = (line: string, key: string) => line.split(INLINE).filter(Boolean).map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("`") && part.endsWith("`")) return <Text key={k} style={{ fontFamily: font.mono, fontSize: size - 2, backgroundColor: t.surface2 }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith("**")) return <Text key={k} style={{ fontFamily: font.sansSemi }}>{part.slice(2, -2)}</Text>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <Text key={k} onPress={() => void Linking.openURL(link[2]!)} style={{ textDecorationLine: "underline" }}>{link[1]}</Text>;
    if (part.startsWith("@") && known.has(part.slice(1).toLowerCase())) return <Text key={k} style={{ fontFamily: font.sansSemi, backgroundColor: t.surface3 }}>{part}</Text>;
    return <Text key={k}>{part}</Text>;
  });
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, bi) => {
        if (bi % 2 === 1) return (
          <View key={bi} style={{ backgroundColor: t.surface2, borderWidth: 1, borderColor: t.line, borderRadius: radius.control, padding: 10 }}>
            <Text style={{ fontFamily: font.mono, fontSize: 12, lineHeight: 18, color: t.ink }}>{block.replace(/\n$/, "")}</Text>
          </View>
        );
        return block.split(/\n{2,}/).filter((p) => p.trim()).map((para, pi) => {
          const lines = para.split("\n");
          const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || !l.trim());
          if (isList) return (
            <View key={`${bi}-${pi}`} style={{ gap: 3 }}>
              {lines.filter((l) => l.trim()).map((l, li) => {
                const m = l.match(/^\s*([-*]|\d+\.)\s+(.*)$/)!;
                return <View key={li} style={{ flexDirection: "row", gap: 8 }}><Text style={{ fontFamily: font.mono, fontSize: size - 2, lineHeight: lh, color: t.ink3 }}>{/\d/.test(m[1]!) ? m[1] : "–"}</Text><Text style={{ flex: 1, fontFamily: font.sans, fontSize: size, lineHeight: lh, color: t.ink }}>{inline(m[2]!, `${bi}-${pi}-${li}`)}</Text></View>;
              })}
            </View>
          );
          if (lines.every((l) => l.startsWith(">"))) return (
            <View key={`${bi}-${pi}`} style={{ borderLeftWidth: 2, borderLeftColor: t.line2, paddingLeft: 10 }}>
              <Text style={{ fontFamily: font.sans, fontSize: size - 1, lineHeight: lh, color: t.ink2 }}>{inline(lines.map((l) => l.replace(/^>\s?/, "")).join("\n"), `${bi}-${pi}`)}</Text>
            </View>
          );
          const h = para.match(/^#{1,4}\s+(.*)$/);
          if (h && lines.length === 1) return <Text key={`${bi}-${pi}`} style={{ fontFamily: font.sansSemi, fontSize: size, lineHeight: lh, color: t.ink }}>{inline(h[1]!, `${bi}-${pi}`)}</Text>;
          return <Text key={`${bi}-${pi}`} style={{ fontFamily: font.sans, fontSize: size, lineHeight: lh, color: t.ink }}>{inline(para, `${bi}-${pi}`)}</Text>;
        });
      })}
    </View>
  );
}

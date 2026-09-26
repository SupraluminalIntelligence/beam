import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Image, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { font, radius, space, useTheme, type Theme } from "../lib/theme";
import { HARNESS } from "../lib/agents";
import { chladni, CLAUDE_MARK, CODEX_MARK } from "../lib/marks";

type Tone = "ink" | "ink2" | "ink3" | "live" | "warn" | "bad" | "add" | "del" | "surface";
type TProps = {
  children: ReactNode; mono?: boolean; display?: boolean; weight?: "regular" | "medium" | "semi" | "bold";
  size?: number; tone?: Tone; caps?: boolean; italic?: boolean; lines?: number; style?: StyleProp<TextStyle>; selectable?: boolean;
};

function family(p: TProps) {
  if (p.display) return p.weight === "bold" ? font.displayBold : font.display;
  if (p.mono) return p.weight === "semi" || p.weight === "bold" ? font.monoSemi : p.weight === "medium" ? font.monoMedium : font.mono;
  if (p.italic) return font.sansItalic;
  return p.weight === "semi" || p.weight === "bold" ? font.sansSemi : p.weight === "medium" ? font.sansMedium : font.sans;
}

/** All text goes through here so the three families stay consistent. */
export function T(p: TProps) {
  const t = useTheme();
  const size = p.size ?? (p.mono ? 11 : 15);
  return (
    <Text
      numberOfLines={p.lines}
      selectable={p.selectable}
      style={[{ fontFamily: family(p), fontSize: size, lineHeight: Math.round(size * (p.mono ? 1.4 : 1.42)), color: t[p.tone ?? "ink"] }, p.caps && { textTransform: "uppercase", letterSpacing: size * 0.2 }, p.style]}
    >
      {p.children}
    </Text>
  );
}

/** Uppercase mono section label. */
export function Label({ children, right, style }: { children: ReactNode; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.padX, paddingTop: 20, paddingBottom: 8 }, style]}>
      <T mono caps size={10.5} tone="ink3">{children}</T>
      {right}
    </View>
  );
}

export type SqState = "idle" | "ok" | "work" | "warn" | "bad" | "off";
/** The status square. Live pulses; nothing else moves. */
export function Sq({ state, size = 8 }: { state: SqState; size?: number }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (state !== "work") { pulse.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 800, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [state, pulse]);
  const color = { idle: t.line2, off: t.line2, ok: t.ok, work: t.live, warn: t.warn, bad: t.bad }[state];
  return <Animated.View style={{ width: size, height: size, backgroundColor: color, opacity: pulse }} />;
}


/** A person: their GitHub photo, else a Chladni plate fixed by login. Never initials, never hue. */
export function Avatar({ login, name, image, size = 24 }: { login: string; name?: string; image?: string | null; size?: number }) {
  const t = useTheme();
  if (image) return <Image source={{ uri: image }} accessibilityLabel={name ?? login} style={{ width: size, height: size, borderRadius: radius.control, backgroundColor: t.surface3 }} />;
  const grid = size >= 20 ? 26 : 14;
  return (
    <View accessibilityLabel={name ?? login} style={{ width: size, height: size, borderRadius: radius.control, backgroundColor: t.surface2, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, overflow: "hidden" }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${grid} ${grid}`}><Path d={chladni(login, grid)} fill={t.ink} /></Svg>
    </View>
  );
}

export { HARNESS };
/** An agent: the harness's own mark in ink on a square, no box. omp keeps its letter tile. */
export function AgentMark({ harness, size = 24 }: { harness: string; size?: number }) {
  const t = useTheme();
  if (harness === "omp" || !(harness === "claude" || harness === "codex")) return (
    <View style={{ width: size, height: size, backgroundColor: t.ink2, alignItems: "center", justifyContent: "center" }}>
      <T mono size={size * 0.42} tone="surface">{harness === "omp" ? "π" : (harness[0] ?? "?").toUpperCase()}</T>
    </View>
  );
  const inner = size * 0.8;
  return (
    <View accessibilityLabel={HARNESS[harness]?.name} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={inner} height={inner} viewBox="0 0 24 24"><Path d={harness === "codex" ? CODEX_MARK : CLAUDE_MARK} fill={t.ink} /></Svg>
    </View>
  );
}

/** Overlapping faces, no border and no count. */
export function Stack({ children, size = 24 }: { children: ReactNode[]; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row" }}>
      {children.map((c, i) => (
        <View key={i} style={{ marginLeft: i ? -size * 0.22 : 0, borderWidth: 2, borderColor: t.surface, borderRadius: radius.control + 2 }}>{c}</View>
      ))}
    </View>
  );
}

export function Tile({ name, size = 28 }: { name: string; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, backgroundColor: t.ink, borderRadius: radius.control, alignItems: "center", justifyContent: "center" }}>
      <T display weight="bold" size={size * 0.42} tone="surface">{name.split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase()}</T>
    </View>
  );
}

/** A full-width pressable row with a hairline under it. */
export function Row({ children, style, ...rest }: PressableProps & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <Pressable {...rest} style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.padX, paddingVertical: 8, minHeight: space.row, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, backgroundColor: pressed ? t.surface2 : "transparent" }, style]}>
      {children}
    </Pressable>
  );
}

export function Button({ label, onPress, primary, danger, style, disabled }: { label: string; onPress: () => void; primary?: boolean; danger?: boolean; style?: StyleProp<ViewStyle>; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [{ minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radius.control, borderWidth: 1, borderColor: primary ? t.ink : t.line2, backgroundColor: primary ? t.ink : pressed ? t.surface2 : "transparent", opacity: disabled ? 0.5 : 1, paddingHorizontal: 16 }, style]}>
      <T mono={!primary} weight={primary ? "medium" : "regular"} size={primary ? 16 : 13} tone={primary ? "surface" : danger ? "bad" : "ink"}>{label}</T>
    </Pressable>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={{ paddingHorizontal: space.padX, paddingVertical: 28, gap: 6 }}>
      <T weight="medium" tone="ink2">{title}</T>
      {children ? <T size={14} tone="ink3">{children}</T> : null}
    </View>
  );
}

type IconName = "back" | "search" | "plus" | "down" | "right" | "more" | "chats" | "inbox" | "you" | "lock" | "send" | "branch" | "pr" | "laptop" | "mini" | "desktop" | "github" | "external";
/** Line icons at 1.6 stroke, drawn on a 24 grid. */
export function Icon({ name, size = 21, color }: { name: IconName; size?: number; color?: string }) {
  const t = useTheme();
  const c = color ?? t.ink2;
  const s = { stroke: c, strokeWidth: 1.6, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, ReactNode> = {
    back: <Path d="M15 5l-7 7 7 7" {...s} strokeWidth={1.8} />,
    search: <><Circle cx={10.5} cy={10.5} r={6.5} {...s} /><Path d="m16 16 5 5" {...s} /></>,
    plus: <Path d="M12 5v14M5 12h14" {...s} />,
    down: <Path d="M6 9l6 6 6-6" {...s} strokeWidth={1.8} />,
    right: <Path d="M9 6l6 6-6 6" {...s} strokeWidth={1.8} />,
    more: <><Circle cx={5} cy={12} r={1.2} fill={c} /><Circle cx={12} cy={12} r={1.2} fill={c} /><Circle cx={19} cy={12} r={1.2} fill={c} /></>,
    chats: <Path d="M4 5h16v11H9l-5 4z" {...s} />,
    inbox: <Path d="M4 4h16v16H4zM4 14h5l1.5 2h3L15 14h5" {...s} />,
    you: <><Circle cx={12} cy={8.5} r={4} {...s} /><Path d="M4 21c1-4 4-6 8-6s7 2 8 6" {...s} /></>,
    lock: <><Rect x={5} y={10} width={14} height={10} {...s} /><Path d="M8 10V7a4 4 0 0 1 8 0v3" {...s} /></>,
    send: <Path d="M12 19V5M5 12l7-7 7 7" {...s} strokeWidth={2} />,
    branch: <><Circle cx={6} cy={5} r={2} {...s} /><Circle cx={6} cy={19} r={2} {...s} /><Circle cx={18} cy={7} r={2} {...s} /><Path d="M6 7v10M18 9c0 5-7 4-11 8" {...s} /></>,
    pr: <><Circle cx={6} cy={5} r={2} {...s} /><Circle cx={6} cy={19} r={2} {...s} /><Circle cx={18} cy={19} r={2} {...s} /><Path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5" {...s} /></>,
    laptop: <><Rect x={4} y={5} width={16} height={11} {...s} /><Path d="M2 19h20" {...s} /></>,
    mini: <><Rect x={3} y={9} width={18} height={7} {...s} /><Path d="M6.5 12.5h2" {...s} /></>,
    desktop: <><Rect x={3} y={4} width={18} height={12} {...s} /><Path d="M9 20h6M12 16v4" {...s} /></>,
    github: <Path fill={c} d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />,
    external: <Path d="M7 17 17 7M9 7h8v8" {...s} />,
  };
  return <Svg width={size} height={size} viewBox="0 0 24 24">{paths[name]}</Svg>;
}

/** The top bar: back, a title that may carry a status line, and trailing controls. */
export function TopBar({ title, sub, onBack, onTitle, right, big, nameCase }: { title: ReactNode; sub?: ReactNode; onBack?: () => void; onTitle?: () => void; right?: ReactNode; big?: boolean; nameCase?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ height: 52, flexDirection: "row", alignItems: "center", paddingLeft: onBack ? 6 : space.padX, paddingRight: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, backgroundColor: t.surface }}>
      {onBack ? <Pressable onPress={onBack} hitSlop={8} style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }} accessibilityLabel="Back"><Icon name="back" size={23} color={t.ink} /></Pressable> : null}
      <Pressable onPress={onTitle} disabled={!onTitle} style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        {typeof title === "string"
          ? <T lines={1} mono={nameCase} caps={nameCase} display={big} weight="semi" size={big ? 20 : nameCase ? 13 : 16} style={nameCase ? { letterSpacing: 0.8 } : undefined}>{title}</T>
          : title}
        {sub ? <T mono size={10.5} tone="ink3" lines={1}>{sub}</T> : null}
      </Pressable>
      {right}
    </View>
  );
}

export function useStyles<S>(make: (t: Theme) => S): S {
  const t = useTheme();
  return make(t);
}

import { useMutation } from "convex/react";
import { BlurView } from "expo-blur";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, type Id } from "../lib/convex";
import { useTheme } from "../lib/theme";
import { T } from "../ui";
import type { Anchor } from "./Rows";

/** Same sets as the desktop: four quick reactions, six more behind +. */
export const QUICK = ["👍", "🔥", "👀", "✅"];
export const MORE = ["💯", "🚀", "🤔", "😂", "🙏", "👎"];

export type Held = {
  id: Id<"messages">; text: string;
  /** The same body the row renders, so the lifted copy is the message itself. */
  body: React.ReactNode;
  reactions: { emoji: string; by: string[] }[];
  /** Who to @mention from here: a teammate's login or an agent's handle. Null for your own messages. */
  mention: { handle: string; label: string } | null;
  anchor: Anchor;
};

const buzz = (kind: "select" | "success" = "select") => { if (Platform.OS === "web") return; void (kind === "success" ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) : Haptics.selectionAsync()); };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const CELL = 46, PAD = 6, MENU_W = 232, GAP = 10, MENU_R = 14;

/**
 * Hold a message and that same block lifts in place while everything behind it blurs. A reaction bubble grows out of your finger above it and a small
 * menu grows below it. If the message sits too low or too high, the whole group slides to stay on screen.
 */
export function MessageActions({ held, me, onClose, onReply, onMention, onCopied }: { held: Held | null; me: string; onClose: () => void; onReply: (h: Held) => void; onMention: (handle: string) => void; onCopied: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { width: W, height: H } = useWindowDimensions();
  const react = useMutation(api.messages.react);
  const [more, setMore] = useState(false);
  const scheme = useColorScheme();
  const grow = useRef(new Animated.Value(0)).current;
  const menu = useRef(new Animated.Value(0)).current;
  const dim = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!held) return;
    setMore(false);
    [grow, menu, dim, lift].forEach((v) => v.setValue(0));
    Animated.parallel([
      Animated.timing(dim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(lift, { toValue: 1, speed: 16, bounciness: 5, useNativeDriver: true }),
      Animated.sequence([Animated.delay(60), Animated.spring(grow, { toValue: 1, speed: 18, bounciness: 9, useNativeDriver: true })]),
      Animated.sequence([Animated.delay(100), Animated.spring(menu, { toValue: 1, speed: 18, bounciness: 7, useNativeDriver: true })]),
    ]).start();
  }, [held, grow, menu, dim, lift]);

  if (!held) return null;
  const a = held.anchor;
  const close = () => {
    Animated.parallel([
      Animated.timing(dim, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(grow, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(menu, { toValue: 0, duration: 120, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start(() => onClose());
  };
  const mine = (e: string) => held.reactions.find((r) => r.emoji === e)?.by.includes(me) ?? false;
  const pick = (e: string) => { buzz(); void react({ messageId: held.id, emoji: e }); close(); };

  // Geometry: bubble above the message, menu below, all nudged to fit between the safe areas.
  const emoji = more ? [...QUICK, ...MORE] : [...QUICK, "+"];
  const perRow = 5;
  const rows = Math.ceil(emoji.length / perRow);
  const bubbleW = Math.min(W - 16, perRow * CELL + PAD * 2 + 2), bubbleH = rows * CELL + PAD * 2 + 2;
  const actions = 1 + (held.mention ? 1 : 0) + (held.text ? 1 : 0);
  const menuH = actions * 48;
  const card = a.h;
  const top0 = a.y - bubbleH - GAP;
  const total = bubbleH + GAP + card + GAP + menuH;
  const top = clamp(top0, insets.top + 8, H - insets.bottom - 8 - total);
  const shift = top - top0;
  const bubbleLeft = clamp(a.touchX - bubbleW / 2, 8, W - bubbleW - 8);
  const menuLeft = clamp(a.touchX - MENU_W / 2, 8, W - MENU_W - 8);
  const originBubble = `${clamp(a.touchX - bubbleLeft, 0, bubbleW)}px ${bubbleH}px`;
  const originMenu = `${clamp(a.touchX - menuLeft, 0, MENU_W)}px 0px`;
  const pop = (v: Animated.Value) => ({ opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }] });

  const action = (label: string, detail: string | null, run: () => void, last: boolean) => (
    <Pressable key={label} onPress={run} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", height: 48, paddingHorizontal: 14, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: t.line, backgroundColor: pressed ? t.surface2 : "transparent" })}>
      <T style={{ flex: 1 }}>{label}</T>
      {detail ? <T mono size={11} tone="ink3">{detail}</T> : null}
    </Pressable>
  );
  const items = [
    { label: "Reply", detail: "quotes it", run: () => { onReply(held); close(); } },
    ...(held.mention ? [{ label: `Mention ${held.mention.label}`, detail: `@${held.mention.handle}`, run: () => { onMention(held.mention!.handle); close(); } }] : []),
    ...(held.text ? [{ label: "Copy text", detail: null, run: () => { void Clipboard.setStringAsync(held.text).then(() => { buzz("success"); onCopied(); }); close(); } }] : []),
  ];
  const soft = { shadowColor: "#000", shadowOffset: { width: 0, height: 10 }, shadowOpacity: scheme === "dark" ? 0.5 : 0.16, shadowRadius: 22, elevation: 10 };
  const floating = { backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line2, ...soft };

  return (
    <Modal transparent visible animationType="none" onRequestClose={close} statusBarTranslucent>
      {/* everything else blurs */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: dim }]}>
        <BlurView intensity={Platform.OS === "ios" ? 28 : 40} tint={scheme === "dark" ? "dark" : "light"} style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: scheme === "dark" ? "rgba(0,0,0,0.25)" : "rgba(20,20,20,0.08)" }]} />
      </Animated.View>
      <Pressable onPress={close} style={StyleSheet.absoluteFill} accessibilityLabel="Close" />

      {/* the message itself, raised a little off the page */}
      <Animated.View pointerEvents="box-none" style={{ position: "absolute", top: a.y, left: a.x, width: a.w,
        transform: [{ translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, shift] }) }, { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.018] }) }] }}>
        <Animated.View style={[{ position: "absolute", top: 4, bottom: -8, left: 8, right: 8, borderRadius: MENU_R + 2, backgroundColor: t.surface, opacity: lift }, soft]} />
        {held.body}
      </Animated.View>

      {/* reaction bubble, grows out of the finger */}
      <Animated.View style={[{ position: "absolute", top: top, left: bubbleLeft, width: bubbleW, height: bubbleH, borderRadius: CELL / 2 + PAD, padding: PAD, flexDirection: "row", flexWrap: "wrap", transformOrigin: originBubble }, floating, pop(grow)]}>
        {emoji.map((e) => e === "+" ? (
          <Pressable key="+" onPress={() => { buzz(); setMore(true); }} accessibilityLabel="More reactions" style={{ width: CELL, height: CELL, alignItems: "center", justifyContent: "center" }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: t.line2, alignItems: "center", justifyContent: "center" }}><T mono size={16} tone="ink2">+</T></View>
          </Pressable>
        ) : (
          <Pressable key={e} onPress={() => pick(e)} accessibilityLabel={`React ${e}`} style={({ pressed }) => ({ width: CELL, height: CELL, alignItems: "center", justifyContent: "center", borderRadius: CELL / 2, backgroundColor: mine(e) ? t.surface3 : pressed ? t.surface2 : "transparent", transform: [{ scale: pressed ? 1.2 : 1 }] })}>
            <T size={26} style={{ lineHeight: 33 }}>{e}</T>
          </Pressable>
        ))}
      </Animated.View>

      {/* the menu, drops from the same point */}
      <Animated.View style={[{ position: "absolute", top: a.y + shift + card + GAP, left: menuLeft, width: MENU_W, borderRadius: MENU_R, overflow: Platform.OS === "android" ? "hidden" : "visible", transformOrigin: originMenu }, floating, pop(menu)]}>
        <View style={{ borderRadius: MENU_R, overflow: "hidden" }}>
          {items.map((it, i) => action(it.label, it.detail, it.run, i === items.length - 1))}
        </View>
      </Animated.View>
    </Modal>
  );
}

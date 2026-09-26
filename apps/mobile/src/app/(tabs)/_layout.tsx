import { useQuery } from "convex/react";
import { Tabs } from "expo-router";
import type { ComponentProps } from "react";

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>["tabBar"]>>[0];
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../lib/convex";
import { useTheme } from "../../lib/theme";
import { Icon, T } from "../../ui";

const TABS = [
  { name: "index", label: "Chats", icon: "chats" },
  { name: "inbox", label: "Inbox", icon: "inbox" },
  { name: "you", label: "You", icon: "you" },
] as const;

export default function TabsLayout() {
  return <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} />}>{TABS.map((x) => <Tabs.Screen key={x.name} name={x.name} />)}</Tabs>;
}

/** Mono caps labels under line icons; the current tab gets a 2px rule on top. */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const inbox = useQuery(api.notifications.inbox);
  const unread = (inbox ?? []).filter((n) => n.readAt === null).length;
  return (
    <View style={{ flexDirection: "row", backgroundColor: t.surface2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line, paddingBottom: insets.bottom }}>
      {TABS.map((tab, i) => {
        const on = state.index === i;
        return (
          <Pressable key={tab.name} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => { const route = state.routes[i]!; const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true }); if (!on && !e.defaultPrevented) navigation.navigate(route.name); }}
            style={{ flex: 1, height: 58, alignItems: "center", justifyContent: "center", gap: 4 }}>
            {on ? <View style={{ position: "absolute", top: 0, left: "22%", right: "22%", height: 2, backgroundColor: t.ink }} /> : null}
            <View>
              <Icon name={tab.icon} color={on ? t.ink : t.ink3} />
              {tab.name === "inbox" && unread > 0 ? <View style={{ position: "absolute", left: 14, top: -6, minWidth: 16, height: 16, paddingHorizontal: 4, backgroundColor: t.warn, alignItems: "center", justifyContent: "center", borderRadius: 2 }}><T mono size={9.5} tone="surface">{unread > 99 ? "99+" : String(unread)}</T></View> : null}
            </View>
            <T mono caps size={9.5} tone={on ? "ink" : "ink3"}>{tab.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

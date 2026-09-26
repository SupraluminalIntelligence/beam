import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";

/** A full screen on the surface colour, clear of the notch. */
export function Screen({ children, bottom }: { children: ReactNode; bottom?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={{ flex: 1, backgroundColor: t.surface, paddingTop: insets.top, paddingBottom: bottom ? insets.bottom : 0 }}>{children}</View>;
}

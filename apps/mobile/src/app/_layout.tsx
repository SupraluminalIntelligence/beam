import { IBMPlexSans_400Regular, IBMPlexSans_400Regular_Italic, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans";
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold } from "@expo-google-fonts/jetbrains-mono";
import { SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { convex, tokenStorage } from "../lib/convex";
import { useTheme } from "../lib/theme";

void SplashScreen.preventAutoHideAsync();

export default function Root() {
  const [fonts] = useFonts({
    IBMPlexSans_400Regular, IBMPlexSans_400Regular_Italic, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold,
    JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_600SemiBold, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold,
  });
  if (!fonts) return null;
  return (
    <ConvexAuthProvider client={convex} storage={tokenStorage}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <Routes />
        </KeyboardProvider>
      </SafeAreaProvider>
    </ConvexAuthProvider>
  );
}

function Routes() {
  const t = useTheme();
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(() => { if (!isLoading) void SplashScreen.hideAsync(); }, [isLoading]);
  if (isLoading) return null;
  const sheet = { presentation: "formSheet" as const, sheetAllowedDetents: [0.62, 1], sheetGrabberVisible: true, sheetCornerRadius: 6, contentStyle: { backgroundColor: t.surface } };
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.surface } }}>
        <Stack.Protected guard={!isAuthenticated}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="chat/[id]/index" />
          <Stack.Screen name="chat/[id]/details" />
          <Stack.Screen name="chat/[id]/people" options={sheet} />
          <Stack.Screen name="workspace/[id]" />
        </Stack.Protected>
      </Stack>
    </>
  );
}

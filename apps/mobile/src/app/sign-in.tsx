import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Image, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, SITE_URL } from "../lib/convex";
import { useTheme } from "../lib/theme";
import { Button, Icon, T } from "../ui";

/**
 * The desktop app's sign-in, reused: the phone asks for a code, you approve it on Beam's website where
 * your GitHub session lives, and the phone signs in with the "device" provider. No new auth surface.
 */
export default function SignIn() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      const r = await fetch(`${SITE_URL}/runner/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "desktop", name: Platform.OS === "web" ? "Beam for the web" : "Beam for iPhone", hostname: Platform.OS }) });
      const d = (await r.json()) as { deviceCode: string; userCode: string; verifyUrl: string };
      setWaiting(d.userCode);
      if (Platform.OS === "web") window.open(d.verifyUrl, "_blank", "noopener");
      else void WebBrowser.openBrowserAsync(d.verifyUrl, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
      const started = Date.now();
      while (Date.now() - started < 15 * 60_000) {
        await new Promise((res) => setTimeout(res, 2000));
        const st = await convex.query(api.runnerAuth.pending, { userCode: d.userCode }).catch(() => null);
        if (!st) { setError("That code expired. Try again."); break; }
        if (st.status !== "approved") continue;
        if (Platform.OS !== "web") WebBrowser.dismissBrowser();
        const res = await signIn("device", { deviceCode: d.deviceCode });
        if (res.signingIn) return;
        setError("Sign-in did not complete. Try again."); break;
      }
    } catch (e) {
      setError(String((e as Error).message ?? e).slice(0, 140));
    }
    setWaiting(null);
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.surface, paddingTop: insets.top, paddingBottom: insets.bottom, paddingHorizontal: 32, justifyContent: "center", gap: 28 }}>
      <View style={{ gap: 8 }}>
        <Image source={require("../../assets/mark.png")} style={{ width: 30, height: 30, marginBottom: 10 }} />
        <T mono caps size={11} tone="ink3">Supraluminal Intelligence</T>
        <T display weight="bold" size={46} style={{ letterSpacing: -1, lineHeight: 50 }}>Beam</T>
        <T display size={20} tone="ink2">Argue it out. Then beam it.</T>
      </View>
      {waiting ? (
        <View style={{ gap: 10 }}>
          <T weight="medium">Approve this code on Beam's website</T>
          <T mono weight="semi" size={28} style={{ letterSpacing: 3 }}>{waiting}</T>
          <T size={14} tone="ink3">A browser opened on Beam. Sign in with GitHub there if asked, then tap Approve. This screen continues by itself.</T>
          <Button label="Cancel" onPress={() => setWaiting(null)} />
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <Button primary label="Sign in with GitHub" onPress={start} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><Icon name="github" size={13} color={t.ink3} /><T mono size={11} tone="ink3">through Beam's website, one time</T></View>
        </View>
      )}
      {error ? <T mono size={12} tone="bad">{error}</T> : null}
      <T size={13} tone="ink3"><T size={13} weight="medium" tone="ink2">Membership follows repo access. </T>You approve Beam once in your browser. Beam never sees your GitHub password or your model provider keys.</T>
    </View>
  );

}

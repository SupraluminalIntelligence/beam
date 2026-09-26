import { useAuthActions } from "@convex-dev/auth/react";
import { useConvex } from "convex/react";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import { Image, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, SITE_URL } from "../lib/convex";
import { waitForApproval } from "../lib/deviceCode";
import { errorText } from "../lib/format";
import { useTheme } from "../lib/theme";
import { Button, Icon, T } from "../ui";

/**
 * The desktop app's sign-in, reused: the phone asks for a code, you approve it on Beam's website where
 * your GitHub session lives, and the phone signs in with the "device" provider. No new auth surface.
 */
/** The in-app browser only exists on iOS, and dismissing it rejects when there is nothing to dismiss. */
const closeBrowser = () => { if (Platform.OS === "ios") void WebBrowser.dismissBrowser().catch(() => {}); };

export default function SignIn() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Once the code is approved and handed to the device provider, the sign-in cannot be called back, so Cancel is withdrawn.
  const [committed, setCommitted] = useState(false);
  // Each tap of Sign in is one attempt. Cancel, a newer attempt, or leaving the screen bumps this, and the old attempt stops at its next await.
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);

  function cancel() {
    attempt.current++;
    setWaiting(null);
    closeBrowser();
  }

  async function start() {
    const mine = ++attempt.current;
    const cancelled = () => attempt.current !== mine;
    setError(null);
    try {
      const r = await fetch(`${SITE_URL}/runner/device/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "desktop", name: Platform.OS === "web" ? "Beam for the web" : "Beam for iPhone", hostname: Platform.OS }) });
      if (!r.ok) throw new Error(`Beam could not start sign-in (${r.status}). Try again.`);
      const d = (await r.json()) as { deviceCode: string; userCode: string; verifyUrl: string };
      if (cancelled()) return;
      setWaiting(d.userCode);
      if (Platform.OS === "web") window.open(d.verifyUrl, "_blank", "noopener");
      else void WebBrowser.openBrowserAsync(d.verifyUrl, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
      const result = await waitForApproval({ status: () => convex.query(api.runnerAuth.pending, { userCode: d.userCode }), cancelled });
      if (result === "cancelled") return;
      if (result === "approved") {
        closeBrowser();
        setCommitted(true);
        const res = await signIn("device", { deviceCode: d.deviceCode }).finally(() => setCommitted(false));
        if (res.signingIn) return;
        if (!cancelled()) setError("Sign-in did not complete. Try again.");
      } else setError(result === "expired" ? "That code expired. Try again." : "That took too long. Try again.");
    } catch (e) {
      if (!cancelled()) setError(errorText(e, 140));
    }
    if (!cancelled()) setWaiting(null);
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
          <Button label={committed ? "Signing in" : "Cancel"} disabled={committed} onPress={cancel} />
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

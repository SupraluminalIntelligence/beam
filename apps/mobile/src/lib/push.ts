import { useMutation } from "convex/react";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { api } from "./convex";

// Banners while the app is open too; the server already skips the chat you are looking at on any device.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;

/** Ask once, register this phone's token with Beam. Quietly does nothing on the web, in a simulator, in Expo Go, or before the backend has push. */
export async function registerForPush(register: (a: { token: string; platform: string; deviceName: string | null }) => Promise<unknown>): Promise<string | null> {
  // Expo Go is for quick previews; push belongs to the TestFlight app, which has its own entitlement.
  if (Platform.OS === "web" || !Device.isDevice || !projectId || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } }));
    if (status !== "granted") return null;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await register({ token, platform: Platform.OS, deviceName: Device.deviceName ?? null });
    return token;
  } catch {
    return null;
  }
}

let current: string | null = null;
export const pushToken = () => current;

const openFrom = (response: Notifications.NotificationResponse | null) => {
  const chatId = (response?.notification.request.content.data as { chatId?: string } | undefined)?.chatId;
  if (chatId) router.push({ pathname: "/chat/[id]", params: { id: chatId } });
};

/** Signed-in only: register the phone, and open the chat a tapped notification points at, including the tap that launched the app. */
export function usePush() {
  const register = useMutation(api.push.register);
  useEffect(() => {
    if (Platform.OS === "web") return;
    void registerForPush(register).then((t) => { current = t; });
    const launched = Notifications.getLastNotificationResponse();
    if (launched) setTimeout(() => openFrom(launched), 300);
    const sub = Notifications.addNotificationResponseReceivedListener(openFrom);
    return () => sub.remove();
  }, [register]);
}

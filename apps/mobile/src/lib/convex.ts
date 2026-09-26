import { ConvexReactClient } from "convex/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export { api } from "../../../../convex/_generated/api";
export type { Doc, Id } from "../../../../convex/_generated/dataModel";

export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL ?? "https://cautious-fish-858.convex.cloud";
export const SITE_URL = CONVEX_URL.replace(".convex.cloud", ".convex.site");
export const convex = new ConvexReactClient(CONVEX_URL, { unsavedChangesWarning: false });

/** Session tokens live in the keychain on a phone and in localStorage on the web build. */
const key = (k: string) => k.replace(/[^\w.-]/g, "_");
export const tokenStorage = Platform.OS === "web" ? undefined : {
  getItem: (k: string) => SecureStore.getItemAsync(key(k)),
  setItem: (k: string, v: string) => SecureStore.setItemAsync(key(k), v),
  removeItem: (k: string) => SecureStore.deleteItemAsync(key(k)),
};

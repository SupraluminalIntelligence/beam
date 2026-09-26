import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Beam",
  slug: config.slug ?? "beam",
  // Keep the existing Expo Go preview; native builds and their updates use a
  // fingerprint so updates cannot load against incompatible native modules.
  runtimeVersion: process.env.BEAM_NATIVE_RUNTIME === "1"
    ? { policy: "fingerprint" }
    : config.runtimeVersion,
});

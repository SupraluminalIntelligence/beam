import { useColorScheme } from "react-native";

/** Tokens from apps/web/src/tokens.css. Colour carries meaning: live, warn, bad, diffs. Nothing else. */
export const light = {
  bg: "#EFEFEB", surface: "#FBFBF9", surface2: "#F3F3F0", surface3: "#E6E6E1",
  ink: "#141414", ink2: "#3B3B39", ink3: "#696965", line: "#DEDEDA", line2: "#C4C4BE", shadow: "#D9D9D3",
  live: "#1976A3", warn: "#8F6200", bad: "#B03A30", ok: "#3B3B39", add: "#3F7A2E", del: "#B03A30", scrim: "rgba(0,0,0,0.4)",
};
export type Theme = typeof light;
export const dark: Theme = {
  bg: "#08090B", surface: "#0B0C0E", surface2: "#111317", surface3: "#1B1E24",
  ink: "#E9EBEF", ink2: "#B4B8BF", ink3: "#858A93", line: "#24272D", line2: "#3A3E46", shadow: "#000000",
  live: "#55B6E0", warn: "#E8B23E", bad: "#D9695F", ok: "#B4B8BF", add: "#7FB069", del: "#D9695F", scrim: "rgba(0,0,0,0.55)",
};

export const font = {
  sans: "IBMPlexSans_400Regular", sansItalic: "IBMPlexSans_400Regular_Italic", sansMedium: "IBMPlexSans_500Medium", sansSemi: "IBMPlexSans_600SemiBold",
  mono: "JetBrainsMono_400Regular", monoMedium: "JetBrainsMono_500Medium", monoSemi: "JetBrainsMono_600SemiBold",
  display: "SpaceGrotesk_600SemiBold", displayBold: "SpaceGrotesk_700Bold",
};

/** Square by default: structure is drawn, controls get 2px, floating layers 4px, the composer 6px. */
export const radius = { control: 2, object: 4, composer: 6 };
export const space = { padX: 20, row: 54 };

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

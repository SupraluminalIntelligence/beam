
const A = "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";
const O = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const uri = (d: string) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`)}")`;
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty("--logo-a", uri(A));
  document.documentElement.style.setProperty("--logo-o", uri(O));
}

export function AgentAvatar({ harness, className = "" }: { harness: string; className?: string }) {
  const cls = harness === "codex" ? "codex" : harness === "omp" ? "omp" : "claude";
  return <span className={`av ${cls} ${className}`}>{harness === "omp" ? "π" : "C"}</span>;
}

/** A Chladni figure, fixed per login: the nodal lines of a square plate driven at mode (n, m). Identity by shape, not by hue. */
function chladni(login: string, size: number) {
  let h = 2166136261; for (const c of login) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const n = 1 + (h % 5), m = n + 1 + ((h >>> 8) % 4), sign = (h >>> 16) & 1 ? 1 : -1, N = size >= 20 ? 13 : 7, c = size / N;
  let d = "";
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = (i + 0.5) / N, y = (j + 0.5) / N;
    const f = Math.cos(n * Math.PI * x) * Math.cos(m * Math.PI * y) + sign * Math.cos(m * Math.PI * x) * Math.cos(n * Math.PI * y);
    if (Math.abs(f) < 0.28) d += `M${(i * c).toFixed(2)} ${(j * c).toFixed(2)}h${c.toFixed(2)}v${c.toFixed(2)}h-${c.toFixed(2)}z`;
  }
  return d;
}

export function PersonAvatar({ login, name, image, className = "" }: { login: string; name?: string; image?: string | null; className?: string; hue?: string }) {
  if (image) return <img className={`av ${className}`} src={image} alt={name ?? login} style={{ objectFit: "cover" }} />;
  const size = className.includes("xs") ? 14 : 26;
  return <span className={`av plate ${className}`} title={name ?? login} aria-label={name ?? login} role="img">
    <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true"><path d={chladni(login, size)} /></svg>
  </span>;
}

export const ICO = {
  team: <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="5.5" cy="5.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><circle cx="11" cy="6.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M1.5 13.5c0-2.5 2-4 4-4s4 1.5 4 4" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M10 13.5c0-2 1.5-3.2 3-3.2s2.5 1.2 2.5 3.2" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>,
  lock: <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.3"/></svg>,
};

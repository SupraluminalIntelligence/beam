export function typingNames(rows: { login: string; expiresAt: number }[], me: string, now: number) {
  return [...new Set(rows.filter((r) => r.login !== me && r.expiresAt > now).map((r) => r.login))].sort();
}
export function typingLabel(names: string[]) {
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length === 3 ? "other" : "others"} are typing…`;
}

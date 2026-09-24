/** Resolve human mentions against authorized people only; never guess between names. */
export function mentionTargets(text: string, people: { login: string; name?: string | undefined }[], agentHandles: string[] = []) {
  const reserved = new Set(agentHandles.map(h => h.toLowerCase()));
  const aliases = new Map<string, Set<string>>();
  for (const person of people) {
    for (const alias of [person.login, person.name?.trim().split(/\s+/)[0], person.name?.trim().replace(/\s+/g, "-")]) {
      if (!alias) continue;
      const key = alias.toLowerCase();
      const matches = aliases.get(key) ?? new Set<string>(); matches.add(person.login); aliases.set(key, matches);
    }
  }
  // Code examples, links and email addresses are not pings.
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|https?:\/\/\S+/g, " ");
  const targets = new Set<string>();
  for (const m of prose.matchAll(/(?:^|[\s(\[{])@([a-z0-9-]+)\b/gi)) {
    const handle = m[1]!.toLowerCase();
    if (reserved.has(handle)) continue;
    const exact = people.find(p => p.login.toLowerCase() === handle);
    const matches = exact ? new Set([exact.login]) : aliases.get(handle);
    if (matches?.size === 1) targets.add([...matches][0]!);
  }
  return [...targets];
}

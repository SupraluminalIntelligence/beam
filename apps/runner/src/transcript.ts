/** Split a provider's cumulative reply into stable chat messages at conversation boundaries. */
export class Transcript {
  private boundary = 0;
  private next = 0;
  private streams = new Map<string, { text: string; parts: { key: string; text: string; boundary: number }[] }>();

  split() { this.boundary += 1; }

  write(id: string, value: string, final: boolean): { key: string; text: string }[] {
    const stream = this.streams.get(id) ?? { text: "", parts: [] };
    this.streams.set(id, stream);
    const text = final ? value : stream.text + value;
    if (text === stream.text) return [];
    const updates: { key: string; text: string }[] = [];
    if (text.startsWith(stream.text)) {
      const delta = text.slice(stream.text.length);
      let part = stream.parts.at(-1);
      if (!part || part.boundary !== this.boundary) {
        part = { key: `segment${++this.next}`, text: "", boundary: this.boundary };
        stream.parts.push(part);
      }
      part.text += delta;
      updates.push({ key: part.key, text: part.text });
    } else {
      // Providers may trim or correct their cumulative final text. Map the old
      // segment boundaries through that edit so earlier messages don't duplicate.
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(stream.text.length, text.length) && stream.text[prefix] === text[prefix]) prefix++;
      while (suffix < Math.min(stream.text.length, text.length) - prefix && stream.text[stream.text.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
      const trimmed = stream.text.trim() === text.trim();
      const trimShift = text.length - text.trimStart().length - (stream.text.length - stream.text.trimStart().length);
      const map = (offset: number) => trimmed ? Math.max(0, Math.min(text.length, offset + trimShift)) : offset <= prefix ? offset : offset >= stream.text.length - suffix ? offset + text.length - stream.text.length : prefix;
      let offset = 0;
      for (const [i, part] of stream.parts.entries()) {
        const start = i === 0 ? 0 : map(offset);
        offset += part.text.length;
        const end = i === stream.parts.length - 1 ? text.length : map(offset);
        const next = text.slice(start, end);
        if (next !== part.text) updates.push({ key: part.key, text: next });
        part.text = next;
      }
    }
    stream.text = text;
    return updates;
  }
}

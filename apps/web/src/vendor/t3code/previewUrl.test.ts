import { expect,it } from 'vitest';
import {normalizePreviewUrl} from './previewUrl';
import {extractTerminalLinks} from './terminalLinks';
it('normalizes local hosts to HTTP and public hosts to HTTPS',()=>{
  expect(normalizePreviewUrl('localhost:5173')).toBe('http://localhost:5173/');
  expect(normalizePreviewUrl('[::1]:8000')).toBe('http://[::1]:8000/');
  expect(normalizePreviewUrl('example.com')).toBe('https://example.com/');
  for(const bad of ['','javascript:alert(1)','file:///tmp/test','https://user:secret@example.com','https://a\nb.com'])expect(()=>normalizePreviewUrl(bad)).toThrow();
});
it('opens URLs in logs without trailing sentence punctuation or unbalanced delimiters',()=>{
  expect(extractTerminalLinks('Listening (http://localhost:5173/). See https://example.com/a(b).').map(m=>m.text)).toEqual(['http://localhost:5173/','https://example.com/a(b)']);
  expect(extractTerminalLinks('javascript:alert(1) /etc/passwd')).toEqual([]);
});

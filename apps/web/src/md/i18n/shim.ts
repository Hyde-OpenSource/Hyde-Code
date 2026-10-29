// A tiny stand-in for react-i18next: the ported Munder Difflin components call
// useTranslation().t(key, vars). Hyde Code is English-only, so this looks keys up in
// en.ts and fills {{vars}}. Unknown keys fall back to the key's last segment.
import { EN } from './en.ts';

type Vars = Record<string, string | number>;

function lookup(key: string): unknown {
  let node: unknown = EN;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

export function t(key: string, given: Vars = {}): string {
  const vars: Vars = { godName: 'Hyde', ...given };
  const raw = lookup(key);
  const text = typeof raw === 'string' ? raw : (key.split('.').pop() ?? key);
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ''));
}

const i18n = { language: 'en', dir: () => 'ltr' as const };

export function useTranslation() {
  return { t, i18n };
}

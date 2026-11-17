import { useCallback } from 'react';
import { isMessageKey, useT, type MessageParams, type Translate } from '../i18n';
import type { Msg, Params } from './app';

/** String params that are themselves message keys (e.g. a failure reason) are translated too. */
function resolveParams(t: Translate, params: Params | undefined): MessageParams | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = typeof value === 'string' && isMessageKey(value) ? t(value) : value;
  }
  return out;
}

export function translateMsg(t: Translate, msg: Msg | null | undefined): string {
  if (!msg) return '';
  // Unknown keys stay visible so a missing catalog entry is noticed.
  if (!isMessageKey(msg.key)) return msg.key;
  return t(msg.key, resolveParams(t, msg.params));
}

export type TranslateMsg = (msg: Msg | null | undefined) => string;

/** Translator for controller messages (`Msg`); re-renders on language change. */
export function useMsg(): TranslateMsg {
  const t = useT();
  return useCallback((msg: Msg | null | undefined) => translateMsg(t, msg), [t]);
}

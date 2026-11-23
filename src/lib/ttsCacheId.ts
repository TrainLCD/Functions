import type { TtsLanguage } from '../utils/ttsVoice';
import { sha256Hex } from './crypto';

const HASH_VERSION = 23;
// JSON.stringify の第2引数に配列を渡すと「その名前のキーだけ」を全階層で
// 直列化する。ネストしたオプションは名前がリストに無いと丸ごと落ちるため、
// キャッシュキーへ含めたい値はすべてトップレベルへ平坦化して渡すこと。
export const computeId = async (payload: {
  enDictionaryId?: string;
  enDictionaryVersionId?: string;
  enVoiceName: string;
  jaVoiceName: string;
  model: string;
  pitch: number | null;
  responseFormat: string;
  speed: number | null;
  textEn: string;
  textJa: string;
}): Promise<string> => {
  // 冒頭の車掌タグ混入を検査していない旧音声を再利用しない。
  const version = payload.textJa ? HASH_VERSION + 2 : HASH_VERSION;
  const obj = { ...payload, version } as const;
  const hashPayload = JSON.stringify(obj, Object.keys(obj).sort());
  return sha256Hex(hashPayload);
};

export const computeAudioId = (
  cacheInputs: Parameters<typeof computeId>[0],
  language: TtsLanguage
) => {
  const ja = language === 'ja';
  return computeId({
    ...cacheInputs,
    textJa: ja ? cacheInputs.textJa : '',
    textEn: ja ? '' : cacheInputs.textEn,
    jaVoiceName: ja ? cacheInputs.jaVoiceName : '',
    enVoiceName: ja ? '' : cacheInputs.enVoiceName,
    enDictionaryId: ja ? undefined : cacheInputs.enDictionaryId,
    enDictionaryVersionId: ja ? undefined : cacheInputs.enDictionaryVersionId,
  });
};

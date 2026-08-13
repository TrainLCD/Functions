/**
 * 合成済み TTS 音声を R2 に保存し、メタを KV に書き込む。
 * Queues のメッセージ上限(128KB)に音声が収まらないため、キューを介さず
 * /tts ハンドラから ctx.waitUntil で直接呼ぶ。
 *
 * 日英どちらか片方だけの合成もありうる（ユーザーが無効にしている言語は
 * そもそも合成しない）ため、届いた言語だけを保存する。
 */
import type { Env, TtsCachePayload } from '../types';
import { base64ToBytes } from './crypto';

const getCacheFileExtension = (mimeType: string): 'mp3' | 'wav' | 'pcm' => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('wav')) return 'wav';
  return 'pcm';
};

export const writeTtsCache = async (
  payload: TtsCachePayload,
  env: Env
): Promise<void> => {
  const {
    id,
    jaAudioContent,
    enAudioContent,
    jaAudioMimeType,
    enAudioMimeType,
    textJa,
    textEn,
    model,
    voiceJa,
    voiceEn,
  } = payload;

  if (!id || (!jaAudioContent && !enAudioContent)) {
    console.error('Invalid payload for tts cache', {
      hasId: !!id,
      hasJa: !!jaAudioContent,
      hasEn: !!enAudioContent,
    });
    return;
  }

  const jaContentType = jaAudioMimeType || 'audio/mpeg';
  const enContentType = enAudioMimeType || 'audio/mpeg';
  const jaPath = jaAudioContent
    ? `caches/tts/ja/${id}.${getCacheFileExtension(jaContentType)}`
    : undefined;
  const enPath = enAudioContent
    ? `caches/tts/en/${id}.${getCacheFileExtension(enContentType)}`
    : undefined;

  await Promise.all([
    jaAudioContent && jaPath
      ? env.TTS_BUCKET.put(jaPath, base64ToBytes(jaAudioContent), {
          httpMetadata: { contentType: jaContentType },
        })
      : null,
    enAudioContent && enPath
      ? env.TTS_BUCKET.put(enPath, base64ToBytes(enAudioContent), {
          httpMetadata: { contentType: enContentType },
        })
      : null,
  ]);

  await env.TTS_KV.put(
    `voice:${id}`,
    JSON.stringify({
      id,
      model,
      ...(jaPath
        ? {
            textJa,
            pathJa: jaPath,
            jaAudioMimeType: jaContentType,
            voiceJa,
          }
        : {}),
      ...(enPath
        ? {
            textEn,
            pathEn: enPath,
            enAudioMimeType: enContentType,
            voiceEn,
          }
        : {}),
      createdAt: new Date().toISOString(),
    })
  );
};

/**
 * OpenAI Audio Speech API（gpt-4o-mini-tts）でテキストを音声に変換する。
 * SSML は非対応で、代わりに `instructions` で声色・速度・間の取り方を指示する。
 * 出力は MP3。
 */
import { bytesToBase64 } from '../crypto';

const OPENAI_API_BASE_URL = 'https://api.openai.com';
const SPEECH_PATH = '/v1/audio/speech';

// 合成は数秒で返るが、詰まったときに Worker の CPU/実行時間を食い潰さないよう
// Azure 時代と同じ上限で打ち切る。
const REQUEST_TIMEOUT_MS = 30_000;

// AI Gateway 経由時も読み上げ本文をゲートウェイのログに保存させない（設計: プライバシー）。
// agent/llm.ts と同じ方針。
const GATEWAY_HEADERS = { 'cf-aig-collect-log-payload': 'false' } as const;

export interface TtsOptions {
  /** 読み方の指示（instructions 対応モデルのみ）。未指定なら付けない */
  instructions?: string;
  /** 応答フォーマット。未指定なら mp3 */
  responseFormat?: string;
  /** 読み上げ速度（0.25〜4.0）。未指定なら付けない。API は数値を要求する */
  speed?: number;
}

export interface SynthesizeSpeechParams {
  apiKey: string;
  /** Cloudflare AI Gateway のベース URL。未指定なら OpenAI へ直行 */
  gatewayBaseUrl?: string;
  model: string;
  voiceName: string;
  /** 読み上げるプレーンテキスト */
  text: string;
  opts?: TtsOptions;
}

export interface SynthesizedAudio {
  /** base64 エンコードされた音声 */
  audioContent: string;
  mimeType: string;
}

// response_format と実際に返る Content-Type の対応。応答ヘッダーが欠けていても
// アプリ側が拡張子を判定できるよう、こちらで確定させる。
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm;rate=24000',
};

// instructions を受け付けないモデル。旧 tts-1 系に instructions を送ると
// OpenAI が 400 を返し、/tts 全体が失敗するため送信対象から外す。
const INSTRUCTIONS_UNSUPPORTED_MODELS = new Set(['tts-1', 'tts-1-hd']);

export const modelSupportsInstructions = (model: string): boolean =>
  !INSTRUCTIONS_UNSUPPORTED_MODELS.has(model.trim().toLowerCase());

/**
 * 応答フォーマットを既知の値へ正規化する。環境変数由来の任意文字列（`MP3` の
 * ような大文字や誤字）をそのまま送ると OpenAI が 400 を返し、MIME も引けなくなる。
 */
export const normalizeResponseFormat = (format?: string): string => {
  const value = format?.trim().toLowerCase() || '';
  return value in MIME_BY_FORMAT ? value : 'mp3';
};

/**
 * 読み上げ速度を数値へ正規化する。環境変数は文字列なので、そのまま送ると
 * API のスキーマ検証（number）に弾かれる。範囲外・非数は未指定として扱う。
 */
export const parseSpeed = (speed?: string | number): number | undefined => {
  if (speed === undefined || speed === null || speed === '') {
    return undefined;
  }
  const parsed = typeof speed === 'number' ? speed : Number(speed.trim());
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed >= 0.25 && parsed <= 4.0 ? parsed : undefined;
};

/** リクエストの送信先を組み立てる。Gateway 指定時は末尾スラッシュの揺れを吸収する。 */
export const buildSpeechUrl = (gatewayBaseUrl?: string): string => {
  const gateway = gatewayBaseUrl?.replace(/\/+$/, '') || '';
  return gateway
    ? `${gateway}/openai${SPEECH_PATH}`
    : `${OPENAI_API_BASE_URL}${SPEECH_PATH}`;
};

/** OpenAI へ送るリクエストボディを組み立てる。 */
export const buildSpeechRequestBody = (params: {
  model: string;
  voiceName: string;
  text: string;
  opts?: TtsOptions;
}): Record<string, string | number> => {
  const { model, voiceName, text, opts = {} } = params;
  const speed = parseSpeed(opts.speed);
  return {
    model,
    voice: voiceName,
    input: text,
    response_format: normalizeResponseFormat(opts.responseFormat),
    ...(opts.instructions && modelSupportsInstructions(model)
      ? { instructions: opts.instructions }
      : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
};

export const synthesizeSpeech = async (
  params: SynthesizeSpeechParams
): Promise<SynthesizedAudio> => {
  const { apiKey, gatewayBaseUrl, model, voiceName, text, opts = {} } = params;

  const res = await fetch(buildSpeechUrl(gatewayBaseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'trainlcd-worker',
      ...(gatewayBaseUrl ? GATEWAY_HEADERS : {}),
    },
    body: JSON.stringify(
      buildSpeechRequestBody({ model, voiceName, text, opts })
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `OpenAI TTS returned ${res.status}: ${detail.slice(0, 500)}`
    );
  }

  const format = normalizeResponseFormat(opts.responseFormat);
  const buf = await res.arrayBuffer();
  return {
    audioContent: bytesToBase64(buf),
    mimeType: MIME_BY_FORMAT[format],
  };
};

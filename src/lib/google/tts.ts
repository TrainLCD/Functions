/**
 * Google Cloud Text-to-Speech API（text:synthesize）でテキストを音声に変換する。
 *
 * ボイスは端末内蔵 TTS 相当の系統（Standard / Wavenet / Neural2）を使う。これらは
 * 読み方のプロンプト指示を受け付けないため、声の調子は audioConfig の
 * speakingRate / pitch で調整する。
 *
 * 認証は API キーではなくサービスアカウント（OAuth2）。Cloud TTS は Cloudflare
 * AI Gateway の対応プロバイダではないため、Google へ直行する。
 * 応答の audioContent は API 時点で base64 なので、そのまま返して再変換しない。
 */
import { getGoogleAccessToken } from './accessToken';

const SYNTHESIZE_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// 合成は数秒で返るが、詰まったときに Worker の CPU/実行時間を食い潰さないよう
// OpenAI / Azure 時代と同じ上限で打ち切る。
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 応答フォーマットと audioEncoding / MIME の対応。
 * Cloud TTS の LINEAR16 は RIFF ヘッダ付き（= WAV）、OGG_OPUS は Ogg コンテナで
 * 返るため、拡張子判定に使える MIME をこちらで確定させる。
 * aac / flac / 生 PCM は Cloud TTS に無いので mp3 へ倒す。
 */
const FORMATS = {
  mp3: { encoding: 'MP3', mimeType: 'audio/mpeg' },
  wav: { encoding: 'LINEAR16', mimeType: 'audio/wav' },
  opus: { encoding: 'OGG_OPUS', mimeType: 'audio/ogg' },
} as const;

export type ResponseFormat = keyof typeof FORMATS;

export interface TtsOptions {
  /** 応答フォーマット。未指定なら mp3 */
  responseFormat?: string;
  /** 読み上げ速度（0.25〜4.0）。未指定なら付けない（等速） */
  speed?: number;
  /** 声の高さ（-20.0〜20.0 セミトーン）。未指定なら付けない */
  pitch?: number;
}

export interface SynthesizeSpeechParams {
  /** Cloud TTS を呼べるサービスアカウント鍵 JSON */
  saKeyJson: string;
  /** ボイスのロケール（例: ja-JP）。ボイス名と食い違うと API が 400 を返す */
  languageCode: string;
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

/**
 * 応答フォーマットを既知の値へ正規化する。環境変数由来の任意文字列（`MP3` の
 * ような大文字や、OpenAI 時代の aac / flac / pcm）をそのまま送ると Cloud TTS が
 * 400 を返し、MIME も引けなくなる。
 */
export const normalizeResponseFormat = (format?: string): ResponseFormat => {
  const value = format?.trim().toLowerCase() ?? '';
  return value in FORMATS ? (value as ResponseFormat) : 'mp3';
};

/** 正規化済みフォーマットに対応する MIME。 */
export const mimeTypeForFormat = (format?: string): string =>
  FORMATS[normalizeResponseFormat(format)].mimeType;

/**
 * 読み上げ速度を数値へ正規化する。環境変数は文字列なので、そのまま送ると
 * API のスキーマ検証（number）に弾かれる。範囲外・非数は未指定として扱う。
 */
export const parseSpeed = (speed?: string | number): number | undefined =>
  parseAudioNumber(speed, 0.25, 4.0);

/**
 * アプリから届く読み上げ速度として受け付ける値。アナウンス設定のプリセットと
 * 一対一で対応する。任意の値を通すと同じ文が速度違いで R2/KV に無制限へ積み上がり、
 * 合成回数（＝文字数課金）もその分だけ増えるため、許可リスト方式にしている。
 * MobileApp の REMOTE_TTS_SPEED_RATES と必ず一致させること。
 */
export const ALLOWED_CLIENT_SPEEDS = [0.85, 1.0, 1.15] as const;

// JSON の数値は 1.15 のように二進で表現しきれない値があるため、厳密比較はしない。
const SPEED_EPSILON = 1e-6;

/**
 * リクエストで指定された読み上げ速度を正規化する。許可リストに無い値・不正な値は
 * 「未指定」として扱い、呼び出し側で環境変数の既定値へ倒す。古いアプリは speed を
 * 送ってこないため、未指定は正常系であってエラーにはしない。
 */
export const parseClientSpeed = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  const parsed = parseSpeed(value);
  if (parsed === undefined) {
    return undefined;
  }
  return ALLOWED_CLIENT_SPEEDS.find(
    (allowed) => Math.abs(allowed - parsed) < SPEED_EPSILON
  );
};

/** 声の高さ（セミトーン）を数値へ正規化する。範囲外・非数は未指定として扱う。 */
export const parsePitch = (pitch?: string | number): number | undefined =>
  parseAudioNumber(pitch, -20.0, 20.0);

const parseAudioNumber = (
  value: string | number | undefined,
  min: number,
  max: number
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed >= min && parsed <= max ? parsed : undefined;
};

/** Cloud TTS へ送るリクエストボディを組み立てる。 */
export const buildSynthesizeRequestBody = (params: {
  languageCode: string;
  voiceName: string;
  text: string;
  opts?: TtsOptions;
}): Record<string, unknown> => {
  const { languageCode, voiceName, text, opts = {} } = params;
  const speed = parseSpeed(opts.speed);
  const pitch = parsePitch(opts.pitch);
  return {
    input: { text },
    voice: { languageCode, name: voiceName },
    audioConfig: {
      audioEncoding:
        FORMATS[normalizeResponseFormat(opts.responseFormat)].encoding,
      ...(speed !== undefined ? { speakingRate: speed } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
    },
  };
};

export const synthesizeSpeech = async (
  params: SynthesizeSpeechParams
): Promise<SynthesizedAudio> => {
  const { saKeyJson, languageCode, voiceName, text, opts = {} } = params;
  const accessToken = await getGoogleAccessToken(saKeyJson, TTS_SCOPE);

  const res = await fetch(SYNTHESIZE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'trainlcd-worker',
    },
    body: JSON.stringify(
      buildSynthesizeRequestBody({ languageCode, voiceName, text, opts })
    ),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Google TTS returned ${res.status}: ${detail.slice(0, 500)}`
    );
  }

  const json = (await res.json()) as { audioContent?: unknown };
  if (typeof json.audioContent !== 'string' || json.audioContent.length === 0) {
    throw new Error('Google TTS response missing audioContent');
  }

  return {
    audioContent: json.audioContent,
    mimeType: mimeTypeForFormat(opts.responseFormat),
  };
};

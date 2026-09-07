/**
 * AGENT_MODEL からのプロバイダ解決テスト。
 * @ai-sdk/* は ESM 専用のため Jest ではスタブへ差し替わる（jest.config.js）。
 * スタブは生成時オプションをそのまま持ち回るため、AI Gateway の URL 組み立てと
 * サービスアカウント資格情報の受け渡しを検証できる。
 */
import type { LanguageModel } from 'ai';
import type { Env } from '../types';
import {
  resolveAgentModel,
  resolveGoogleReasoningSetting,
  resolveOpenAIReasoningOptions,
} from './llm';

/** スタブ（test/stubs/ai-sdk-provider.ts）が返す形。実型には無いので読むときだけ被せる */
type StubModel = {
  modelId: string;
  provider: string;
  options?: {
    baseURL?: string;
    headers?: Record<string, string>;
    project?: string;
    location?: string;
    googleCredentials?: {
      clientEmail?: string;
      privateKey?: string;
      privateKeyId?: string;
    };
  };
};
const asStub = (model: LanguageModel): StubModel =>
  model as unknown as StubModel;

const makeEnv = (env: Partial<Env>): Env => env as Env;

/** サービスアカウント鍵 JSON（1 行 JSON 投入を想定し改行はエスケープ済み） */
const SA_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'sa-project',
  private_key_id: 'kid-1',
  private_key:
    '-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n',
  client_email: 'agent@sa-project.iam.gserviceaccount.com',
});

describe('resolveAgentModel', () => {
  it('google: はサービスアカウント鍵から Vertex AI を解決する', () => {
    const model = asStub(
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: SA_KEY,
        })
      )
    );
    expect(model.modelId).toBe('gemini-3.8-flash');
    // プロジェクトは鍵の project_id を既定にし、ロケーションは global
    expect(model.options?.project).toBe('sa-project');
    expect(model.options?.location).toBe('global');
    expect(model.options?.googleCredentials?.clientEmail).toBe(
      'agent@sa-project.iam.gserviceaccount.com'
    );
    expect(model.options?.googleCredentials?.privateKeyId).toBe('kid-1');
    // 1 行 JSON でエスケープされたままの改行は復元してから SDK へ渡す
    expect(model.options?.googleCredentials?.privateKey).toBe(
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n'
    );
    // Gateway 未設定なら Vertex へ直行（baseURL を上書きしない）
    expect(model.options?.baseURL).toBeUndefined();
  });

  it('project / location の var が鍵と既定より優先される', () => {
    const model = asStub(
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: SA_KEY,
          GOOGLE_VERTEX_PROJECT: 'other-project',
          GOOGLE_VERTEX_LOCATION: 'asia-northeast1',
        })
      )
    );
    expect(model.options?.project).toBe('other-project');
    expect(model.options?.location).toBe('asia-northeast1');
  });

  it('AI Gateway 経由では google-vertex-ai のモデルパスを baseURL にする', () => {
    const model = asStub(
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: SA_KEY,
          GOOGLE_VERTEX_LOCATION: 'asia-northeast1',
          // 末尾スラッシュの揺れも吸収する
          AI_GATEWAY_BASE_URL: 'https://gateway.example/v1/acct/gw/',
        })
      )
    );
    expect(model.options?.baseURL).toBe(
      'https://gateway.example/v1/acct/gw/google-vertex-ai/v1beta1/projects/sa-project/locations/asia-northeast1/publishers/google'
    );
    // 会話本文を Gateway のログに残さない設定は他プロバイダと同じ
    expect(model.options?.headers).toEqual({
      'cf-aig-collect-log-payload': 'false',
    });
  });

  it('google: で鍵が無ければエラーにする', () => {
    expect(() =>
      resolveAgentModel(makeEnv({ AGENT_MODEL: 'google:gemini-3.8-flash' }))
    ).toThrow('GOOGLE_VERTEX_SA_KEY is not configured');
  });

  it('鍵の形式が不正ならエラーにする', () => {
    expect(() =>
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: 'not-json',
        })
      )
    ).toThrow('GOOGLE_VERTEX_SA_KEY is not valid JSON');

    expect(() =>
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: JSON.stringify({ project_id: 'p' }),
        })
      )
    ).toThrow(/client_email and private_key/);
  });

  it('project を鍵からも var からも決められなければエラーにする', () => {
    expect(() =>
      resolveAgentModel(
        makeEnv({
          AGENT_MODEL: 'google:gemini-3.8-flash',
          GOOGLE_VERTEX_SA_KEY: JSON.stringify({
            client_email: 'a@b.iam.gserviceaccount.com',
            private_key: 'pk',
          }),
        })
      )
    ).toThrow('GOOGLE_VERTEX_PROJECT is not configured');
  });

  it('未対応のプロバイダ指定はエラーにする', () => {
    expect(() =>
      resolveAgentModel(makeEnv({ AGENT_MODEL: 'gemini-3.8-flash' }))
    ).toThrow(/unsupported AGENT_MODEL/);
  });
});

describe('resolveGoogleReasoningSetting', () => {
  it('思考を完全に止められる 2.5 系では none を返す', () => {
    expect(resolveGoogleReasoningSetting('gemini-2.5-flash')).toBe('none');
  });

  it('3 系は受理される最小値の low まで下げる', () => {
    // 'none' は thinkingLevel: minimal に変換され、Vertex に 400 で拒否される
    expect(resolveGoogleReasoningSetting('gemini-3.8-flash')).toBe('low');
    expect(resolveGoogleReasoningSetting('gemini-3-flash-preview')).toBe('low');
  });

  it('thinkingConfig 非対応の世代・他社モデルには何も指定しない', () => {
    expect(resolveGoogleReasoningSetting('gemini-2.0-flash')).toBeUndefined();
    expect(
      resolveGoogleReasoningSetting('gemini-flash-latest')
    ).toBeUndefined();
    expect(resolveGoogleReasoningSetting('gpt-5.1')).toBeUndefined();
  });

  it('OpenAI 向けの抑制指定は Gemini に反応しない', () => {
    expect(resolveOpenAIReasoningOptions('gemini-3.8-flash')).toBeUndefined();
  });
});

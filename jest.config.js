/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: 'node',
  watchman: false,
  testPathIgnorePatterns: ['/node_modules/'],
  // ai v7 / @ai-sdk / langsmith は ESM 専用で Jest の CJS ランタイムから読めないため、
  // 形だけ互換のスタブへ差し替える。LLM 呼び出しは各テストでモックを注入し、
  // 実プロバイダとの結合は wrangler dev で確認する。
  moduleNameMapper: {
    '^ai$': '<rootDir>/test/stubs/ai-sdk.ts',
    '^@ai-sdk/(anthropic|openai)$': '<rootDir>/test/stubs/ai-sdk-provider.ts',
    '^langsmith$': '<rootDir>/test/stubs/langsmith.ts',
    '^langsmith/experimental/vercel$': '<rootDir>/test/stubs/langsmith.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // ランタイム結合は wrangler dev で確認する。テストは純粋関数のみを
        // トランスパイルのみ（型チェックなし）で実行し、Workers 型の解決を不要にする。
        isolatedModules: true,
        tsconfig: { module: 'commonjs', verbatimModuleSyntax: false },
      },
    ],
  },
};

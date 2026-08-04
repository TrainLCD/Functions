/**
 * SSML タグを除去してプレーンテキストに変換する（byte 数検証や可視テキスト判定用）。
 *
 * <sub> は読み上げに使われる alias 属性値へ置換する（属性順や追加属性、子要素に依存しない）。
 * <break> は空白に、それ以外のタグ（<say-as> / <speak> / <prosody> 等）は中身を残して
 * タグだけ取り除く。これにより属性の書き方の違いで発話内容を取りこぼさない。
 */
export const stripSsml = (text: string): string =>
  text
    // <sub ... alias="X" ...>inner</sub> -> X（属性順非依存・追加属性/子要素を許容）
    .replace(
      /<sub\b[^>]*\balias="([^"]*)"[^>]*>[\s\S]*?<\/sub>/gi,
      (_match, alias) => alias
    )
    // <break .../> -> 空白
    .replace(/<break\b[^>]*\/?>/gi, ' ')
    // 残りのタグは中身を保持してタグのみ除去（say-as の数値/テキストもそのまま残る）
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** UTF-8 バイト長。 */
export const utf8ByteLength = (s: string): number =>
  new TextEncoder().encode(s).length;

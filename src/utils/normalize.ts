import { removeMacron } from './removeMacron';

// ハイフン区切りの頭字語（J-R / J-Y など）。アプリ側が「JR」を読み間違えられない
// 表記へ倒してから送ってくるため、これを capitalizeSegment に通して "J-r" へ
// 崩されないよう素通しする。文末・カンマ前（"J-R." / "J-R,"）も対象にするため、
// セグメント全体一致ではなく後続が英数字でないことを先読みで判定する。
const HYPHENATED_INITIALISM = /^[A-Z](?:-[A-Z])+(?=$|[^A-Za-z0-9])/;

const capitalizeSegment = (seg: string): string => {
  if (HYPHENATED_INITIALISM.test(seg)) {
    return seg;
  }
  return /[A-Z]/.test(seg)
    ? seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()
    : seg;
};

// テキストノード（SSML タグの外側）だけに掛ける正規化。タグやその属性値
// （<sub alias="Sta."> や <phoneme ph="..."> 等）を壊さないため、タグ部分には適用しない。
const normalizeTextNode = (text: string): string =>
  removeMacron(
    text
      .split(' ')
      .map((seg) => capitalizeSegment(seg))
      .join(' ')
  )
    // Airport Terminal 1･2等
    .replace(/･/g, ' ')
    // Otsuka・Teikyo-Daigakuなど
    .replace(/・/g, ' ')
    // 環状運転の場合に & が含まれる可能性があるため置換
    .replace(/&(?!#\d+;|#x[0-9A-Fa-f]+;|\w+;)/g, 'and')
    // 全角記号
    .replace(/[！-／：-＠［-｀｛-～、-〜”・]+/g, ' ')
    // 明治神宮前駅等の駅名にバッククォートが含まれる場合があるため除去
    .replace(/`/g, '')
    .replace(/JR/gi, 'J-R')
    // 都営バスを想定
    .replace(/\bSta\./gi, ' Station')
    .replace(/\bUniv\./gi, ' University')
    .replace(/\bHp\./gi, ' Hospital');

export const normalizeRomanText = (str: string | undefined): string => {
  if (!str) return '';

  // XMLタグを保護しつつテキスト部分のみ正規化する
  return str
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith('<') ? part : normalizeTextNode(part)))
    .join('');
};

// Takamine / Minezaki のように語中・語頭に埋まった "mine" も読み替える。
// 前後に英字が続く場合はハイフンで区切って "Me-nay" を独立させ、
// 語頭のときだけ先頭を大文字にする（Takamine → Taka-me-nay）
const replaceMine = (match: string, offset: number, str: string): string => {
  const before = offset > 0 && /[A-Za-z]/.test(str.charAt(offset - 1));
  const after = /[A-Za-z]/.test(str.charAt(offset + match.length));
  const head = /[A-Z]/.test(match.charAt(0)) ? 'Me' : 'me';
  return `${before ? '-' : ''}${head}-nay${after ? '-' : ''}`;
};

/** Google Cloud TTS に渡す正規化済みの英語原稿に、駅名の読み替えを適用する。 */
export const applyGooglePronunciation = (text: string): string =>
  text
    .replace(/\bKeisei\b/gi, 'Kay-say')
    .replace(/\bSeibu\b/gi, 'Say-boo')
    .replace(/mine/gi, replaceMine);

import { normalizeRomanText } from './normalize';

describe('utils/normalize.ts', () => {
  it('Should be normalized', () => {
    expect(normalizeRomanText('TOKYO')).toBe('Tokyo');
    expect(normalizeRomanText('MEITETSU NAGOYA')).toBe('Meitetsu Nagoya');
    expect(
      normalizeRomanText('Nagoya Main Line bound for MEITETSU GIFU.')
    ).toBe('Nagoya Main Line bound for Meitetsu Gifu.');
    expect(normalizeRomanText('JR Kobe Line')).toBe('J-R Kobe Line');
  });

  it('leaves hyphenated initialisms alone', () => {
    // アプリ側が「JR」を J-R へ倒してから送ってくるため、ここで J-r へ
    // 崩さないこと（= 二重に適用しても結果が変わらない）
    expect(normalizeRomanText('J-R Kobe Line')).toBe('J-R Kobe Line');
    expect(normalizeRomanText(normalizeRomanText('JR Kobe Line'))).toBe(
      'J-R Kobe Line'
    );
    expect(normalizeRomanText('Osaki, J-Y 24.')).toBe('Osaki, J-Y 24.');
  });

  it('keeps hyphenated initialisms next to punctuation', () => {
    // 文末やカンマの直前でも J-r に崩さない
    expect(normalizeRomanText('Please transfer to the J-R.')).toBe(
      'Please transfer to the J-R.'
    );
    expect(normalizeRomanText('Transfer to the J-R, and the subway.')).toBe(
      'Transfer to the J-R, and the subway.'
    );
  });

  it('replaces Keisei with a spelling English TTS reads as けいせい', () => {
    // 英語 TTS は "Keisei" を「かいせい」と読むため、辞書語の綴りへ倒す
    expect(normalizeRomanText('Change here for the Keisei Main Line.')).toBe(
      'Change here for the Kay-say Main Line.'
    );
    expect(normalizeRomanText('The next station is Keisei-Ueno.')).toBe(
      'The next station is Kay-say-ueno.'
    );
    expect(normalizeRomanText('KEISEI SKYLINER')).toBe('Kay-say Skyliner');
    // 別語の一部は置換しない
    expect(normalizeRomanText('Keiseibus')).toBe('Keiseibus');
  });

  it('replaces Seibu with a spelling English TTS reads as せいぶ', () => {
    expect(
      normalizeRomanText('Change here for the Seibu Ikebukuro Line.')
    ).toBe('Change here for the Say-boo Ikebukuro Line.');
    expect(normalizeRomanText('The next station is Seibu-Shinjuku.')).toBe(
      'The next station is Say-boo-shinjuku.'
    );
    // 西武園 (Seibuen) は 1 語なので語単位の一致では対象外
    expect(normalizeRomanText('Seibuen')).toBe('Seibuen');
  });

  it('keeps Kay-say stable when normalized twice', () => {
    // 二重に適用しても結果が変わらないこと（キャッシュキーの安定性）
    expect(normalizeRomanText(normalizeRomanText('Keisei Main Line'))).toBe(
      'Kay-say Main Line'
    );
    expect(normalizeRomanText(normalizeRomanText('Seibu Shinjuku Line'))).toBe(
      'Say-boo Shinjuku Line'
    );
  });

  it.each(['Tokyo', 'tOkyo'])('text: %s', (text) => {
    expect(normalizeRomanText(text)).toBe('Tokyo');
  });

  it('should not modify SSML/XML tags', () => {
    expect(
      normalizeRomanText(
        '<phoneme alphabet="ipa" ph="çɯɯga" xml:lang="ja-JP">HYUGA</phoneme>'
      )
    ).toBe(
      '<phoneme alphabet="ipa" ph="çɯɯga" xml:lang="ja-JP">Hyuga</phoneme>'
    );
  });

  it('should handle mixed text and SSML tags', () => {
    expect(
      normalizeRomanText(
        'The next stop is <phoneme alphabet="ipa" ph="naɾɯtoː" xml:lang="ja-JP">NARUTO</phoneme>.'
      )
    ).toBe(
      'The next stop is <phoneme alphabet="ipa" ph="naɾɯtoː" xml:lang="ja-JP">Naruto</phoneme>.'
    );
  });
});

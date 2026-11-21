import { hasSpokenTag } from './checkedAnnouncement';

it.each([
  ['次はマエバシです。', '通勤電車の次は前橋です。', true],
  ['次はマエバシです。', '「ツウキン デンシャの」次は前橋です。', true],
  ['次はマエバシです。', '次は、前場所です。', false],
  ['ツウキン快速です。', '通勤快速です。', false],
  ['次はマエバシです。', '次は通勤電車です。', false],
])(
  'checks only unexpected tag words at the start of %s / %s',
  (script, transcript, expected) => {
    expect(hasSpokenTag(String(script), String(transcript))).toBe(expected);
  }
);

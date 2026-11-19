import { addStationNameTags, STATION_NAME_TAG as tag } from './stationTags';

it.each([
  [
    'After leaving Kyoto, we will be stopping at Osaka.',
    `After leaving ${tag} Kyoto, we will be stopping at ${tag} Osaka.`,
  ],
  [
    'We will be stopping at Kizu before arriving at Nara.',
    `We will be stopping at ${tag} Kizu before arriving at ${tag} Nara.`,
  ],
  ['The next station is Shinjuku.', `The next station is ${tag} Shinjuku.`],
  ['The next stop is Osaki, J Y 24.', `The next stop is ${tag} Osaki, J Y 24.`],
  [
    'We will soon be arriving at Tokyo terminal Station Number J Y 1.',
    `We will soon be arriving at ${tag} Tokyo terminal Station Number J Y 1.`,
  ],
  [
    'We will soon make a brief stop at Shin-Osaka.',
    `We will soon make a brief stop at ${tag} Shin-Osaka.`,
  ],
  [
    'We will soon be making a brief stop at Shin-Osaka.',
    `We will soon be making a brief stop at ${tag} Shin-Osaka.`,
  ],
  [
    'This train is bound for Tokyo and Ueno via Shinjuku.',
    `This train is bound for ${tag} Tokyo and ${tag} Ueno via ${tag} Shinjuku.`,
  ],
  [
    'The stop after Osaki will be Shinagawa.',
    `The stop after ${tag} Osaki will be ${tag} Shinagawa.`,
  ],
  [
    'After leaving Tokyo, we will stop at Ueno.',
    `After leaving ${tag} Tokyo, we will stop at ${tag} Ueno.`,
  ],
  [
    'We will be stopping at Tokyo, Ueno, and Omiya, the final stop.',
    `We will be stopping at ${tag} Tokyo, ${tag} Ueno, and ${tag} Omiya, the final stop.`,
  ],
  [
    'Stops after Kyoto will be announced later.',
    `Stops after ${tag} Kyoto will be announced later.`,
  ],
  [
    'You can transfer to the Yamanote Line at Shinjuku.',
    `You can transfer to the Yamanote Line at ${tag} Shinjuku.`,
  ],
  [
    'This train will merge and continue traveling on the Tozai Line to Nakano.',
    `This train will merge and continue traveling on the Tozai Line to ${tag} Nakano.`,
  ],
  [
    'Arriving at Kyoto. Thank you for using JR West. Kyoto, Kyoto. This is the final stop.',
    `Arriving at ${tag} Kyoto. Thank you for using JR West. ${tag} Kyoto, ${tag} Kyoto. This is the final stop.`,
  ],
  ['Now stopping at Keisei-Ueno.', `Now stopping at ${tag} Keisei-Ueno.`],
])('tags station slots: %s', (input, expected) => {
  expect(addStationNameTags(input)).toBe(expected);
  expect(addStationNameTags(expected)).toBe(expected);
});

it.each([
  '',
  'Please change here for the Tokyo Metro Marunouchi Line.',
  'Passengers changing to the Seibu Line, please transfer at this station.',
  'Thank you for using the Yamanote Line.',
  'This bus is bound for City Hall. The next stop is Library.',
  `The next station is ${tag} Shinjuku.`,
])('preserves text without untagged station slots: %s', (text) => {
  expect(addStationNameTags(text)).toBe(text);
});

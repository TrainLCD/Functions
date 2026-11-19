import { addLineNameTags, LINE_NAME_TAG as tag } from './lineTags';
import {
  addStationNameTags,
  STATION_NAME_TAG as stationTag,
} from './stationTags';

it.each([
  [
    'Please change here for the Yamanote Line.',
    `Please change here for the ${tag} Yamanote Line.`,
  ],
  [
    'Please change here for the Tokyo Metro Marunouchi Line, and the Fukutoshin Line.',
    `Please change here for the ${tag} Tokyo Metro Marunouchi Line, and the ${tag} Fukutoshin Line.`,
  ],
  [
    'Transfer here for the Chuo Line, the Sobu Line, and the subway.',
    `Transfer here for the ${tag} Chuo Line, the ${tag} Sobu Line, and the subway.`,
  ],
  [
    'Passengers changing to the Keisei Main Line, please transfer at this station.',
    `Passengers changing to the ${tag} Keisei Main Line, please transfer at this station.`,
  ],
  [
    'Passengers transferring to the Tokaido Shinkansen, please change trains here.',
    `Passengers transferring to the ${tag} Tokaido Shinkansen, please change trains here.`,
  ],
  [
    'You can transfer to the Yamanote Line at Shinjuku.',
    `You can transfer to the ${tag} Yamanote Line at Shinjuku.`,
  ],
  [
    'This train will merge and continue traveling on the Tozai Line to Nakano.',
    `This train will merge and continue traveling on the ${tag} Tozai Line to Nakano.`,
  ],
  [
    'This is the Yamanote Line train bound for Tokyo.',
    `This is the ${tag} Yamanote Line train bound for Tokyo.`,
  ],
  [
    'This is a Chuo Line rapid service train bound for Takao.',
    `This is a ${tag} Chuo Line rapid service train bound for Takao.`,
  ],
  [
    'Thank you for using the Tokyo Metro Tozai Line.',
    `Thank you for using the ${tag} Tokyo Metro Tozai Line.`,
  ],
  [
    'Please change here for the Narita Sky Access.',
    `Please change here for the ${tag} Narita Sky Access.`,
  ],
])('tags line slots: %s', (input, expected) => {
  expect(addLineNameTags(input)).toBe(expected);
  expect(addLineNameTags(expected)).toBe(expected);
});

it.each([
  '',
  'Thank you for using JR East.',
  'Thank you for using the Tokyo Metro.',
  'Thank you for using Toei Bus.',
  'This is the Local train bound for Tokyo.',
  'The next station is Shinjuku.',
  'This is the final stop of this line.',
])('leaves non-line slots untouched: %s', (text) => {
  expect(addLineNameTags(text)).toBe(text);
});

it.each([
  [
    'You can transfer to the Yamanote Line at Shinjuku.',
    `You can transfer to the ${tag} Yamanote Line at ${stationTag} Shinjuku.`,
  ],
  [
    'This train will merge and continue traveling on the Tozai Line to Nakano.',
    `This train will merge and continue traveling on the ${tag} Tozai Line to ${stationTag} Nakano.`,
  ],
  [
    'This is the Yamanote Line train bound for Tokyo. The next station is Ueno.',
    `This is the ${tag} Yamanote Line train bound for ${stationTag} Tokyo. The next station is ${stationTag} Ueno.`,
  ],
])('keeps station and line slots separate: %s', (input, expected) => {
  const annotate = (text: string) => addLineNameTags(addStationNameTags(text));
  expect(annotate(input)).toBe(expected);
  expect(annotate(expected)).toBe(expected);
});

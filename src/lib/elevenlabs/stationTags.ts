export const STATION_NAME_TAG = '[Japanese railway station name]';

// /tts receives rendered text, not station IDs. Limit inference to the station
// slots in the app's English announcement templates; never tag arbitrary "at".
const stationIntroductions =
  /\b(?:the next (?:station|stop) is|arriving at|(?:now |be )?stopping at|(?:make|making) a brief stop at|we will stop at|bound for|via|after leaving|the stop after|stops after|you can transfer to [^.]+? at|continue traveling [^.]+? to)\s+/gi;
const stationEnd =
  /[.!?;]|,\s+we\b|\s+before arriving at\b|\s+will be\b|\s+via\b|\s+terminal\b|,?\s+(?:the |this is the )?(?:last|final) stop\b|,?\s+station number\b|,?\s+(?:[A-Z](?:[ -][A-Z])*|[A-Z]{1,3})\s*\d+\b/i;

export const addStationNameTags = (text: string): string => {
  // Bus destinations are not railway stations. Existing tags are left alone.
  if (/\b(?:this bus|bus (?:is )?bound for)\b/i.test(text)) return text;
  const insertions = new Set<number>();
  const names = new Set<string>();
  const addNames = (start: number, end: number) => {
    const segment = text.slice(start, end);
    // Lists of destinations/stops use commas and "and" in the app templates.
    const separator = /,\s*(?:and\s+)?|\s+and\s+/gi;
    let offset = 0;
    for (const part of segment.split(separator)) {
      const leading = part.length - part.trimStart().length;
      const name = part.trim();
      if (name && !name.startsWith('[') && /\p{L}/u.test(name)) {
        insertions.add(start + offset + leading);
        names.add(name);
      }
      offset += part.length;
      separator.lastIndex = offset;
      const match = separator.exec(segment);
      if (match?.index === offset) offset += match[0].length;
    }
  };
  for (const match of text.matchAll(stationIntroductions)) {
    const start = match.index + match[0].length;
    const tail = text.slice(start);
    const end =
      start +
      (tail.search(stationEnd) < 0 ? tail.length : tail.search(stationEnd));
    addNames(start, end);
    // "The stop after X will be Y" contains two station slots.
    if (/^the stop after/i.test(match[0])) {
      const next = /^\s+will be\s+/i.exec(text.slice(end));
      if (next) {
        const nextStart = end + next[0].length;
        const nextTail = text.slice(nextStart);
        const stop = nextTail.search(stationEnd);
        addNames(nextStart, stop < 0 ? text.length : nextStart + stop);
      }
    }
  }
  // JR West repeats the destination as a standalone "X, X." sentence.
  // Only repeat a station identified in an explicit station slot above.
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const repeated = new RegExp(
      `(?:^|[.!?]\\s+)(${escaped}),\\s+(${escaped})(?=[.!?])`,
      'gi'
    );
    for (const match of text.matchAll(repeated)) {
      const first = match.index + match[0].indexOf(match[1]);
      insertions.add(first);
      insertions.add(match.index + match[0].lastIndexOf(match[2]));
    }
  }
  let result = text;
  for (const offset of [...insertions].sort((a, b) => b - a)) {
    result = `${result.slice(0, offset)}${STATION_NAME_TAG} ${result.slice(offset)}`;
  }
  return result;
};

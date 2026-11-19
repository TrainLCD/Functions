export const LINE_NAME_TAG = '[Japanese railway line name]';

// Match the line slots in the app's rendered announcements, not arbitrary
// proper nouns: company acknowledgements and station names are separate slots.
const transferIntroductions =
  /\b(?:please change here for|transfer here for|passengers (?:changing|transferring) to|you can transfer to)\s+/gi;
const transferEnd = /[.!?;]|,?\s+please\b|\s+at\b/i;

export const addLineNameTags = (text: string): string => {
  const insertions = new Set<number>();
  const addLine = (start: number, end: number) => {
    const part = text.slice(start, end);
    const prefix = /^\s*(?:and\s+)?(?:the\s+)?/i.exec(part)?.[0] ?? '';
    const name = part.slice(prefix.length).trim();
    if (
      name &&
      !name.startsWith('[') &&
      /\p{L}/u.test(name) &&
      !/^(?:subway|bus|buses|train|trains)$/i.test(name) &&
      !/^(?:last|final) stop\b/i.test(name)
    ) {
      insertions.add(start + prefix.length);
    }
  };
  for (const match of text.matchAll(transferIntroductions)) {
    const start = match.index + match[0].length;
    const tail = text.slice(start);
    const stop = tail.search(transferEnd);
    const end = stop < 0 ? text.length : start + stop;
    let itemStart = start;
    for (const separator of text.slice(start, end).matchAll(/,|\s+and\s+/gi)) {
      const itemEnd = start + separator.index;
      addLine(itemStart, itemEnd);
      itemStart = itemEnd + separator[0].length;
    }
    addLine(itemStart, end);
  }
  // A through-service's destination after "to" is a station, not a line.
  for (const match of text.matchAll(
    /\bcontinue traveling on\s+(?:the\s+)?([^.!?]+?)(?=\s+to\s)/gi
  )) {
    addLine(
      match.index + match[0].length - match[1].length,
      match.index + match[0].length
    );
  }
  // Requiring a railway suffix keeps "Thank you for using JR East" and
  // "This is the Local train" out of the line-name path.
  for (const match of text.matchAll(
    /\b(?:this is (?:the|a)|thank you for using(?: the)?)\s+([^.!?,]+?\b(?:line|shinkansen|railway|monorail))(?=\s|[.!?,]|$)/gi
  )) {
    addLine(
      match.index + match[0].length - match[1].length,
      match.index + match[0].length
    );
  }
  let result = text;
  for (const offset of [...insertions].sort((a, b) => b - a)) {
    result = `${result.slice(0, offset)}${LINE_NAME_TAG} ${result.slice(offset)}`;
  }
  return result;
};

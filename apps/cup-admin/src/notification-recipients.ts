/**
 * Recipient input parsing for the CUP notification composer. The admin API accepts up to 100 selector
 * values in total, so the composer parses the two textareas into the `phones`/`userIds` selector and
 * keeps malformed PadlHub ids visible: a silently dropped id would send the message to fewer people
 * than the operator selected.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ParsedUserIds {
  readonly ids: readonly string[];
  readonly invalid: readonly string[];
}

export function parsePhones(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\n,;]+/)
        .map((phone) => phone.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseUserIds(value: string): ParsedUserIds {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const token of new Set(
    value
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  )) {
    if (UUID_PATTERN.test(token)) ids.push(token);
    else invalid.push(token);
  }
  return { ids, invalid };
}

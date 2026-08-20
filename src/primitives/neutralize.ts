/**
 * Terminal egress neutralizer for untrusted finding text.
 * It strips control bytes and control sequences before CLI output.
 * It must never decide verdicts, sanitize HTML, or alter identity keys.
 */
export function neutralize(text: string): string {
  if (text.length === 0) {
    return '';
  }

  let safe = '';
  let i = 0;

  // One forward scan avoids chaining replaces that could leave second-order sequences.
  while (i < text.length) {
    const code = text.charCodeAt(i);

    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1);

      if (next === 0x5b) {
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          i += 1;
          if (byte >= 0x40 && byte <= 0x7e) {
            break;
          }
        }
        continue;
      }

      if (next === 0x5d) {
        i += 2;
        while (i < text.length) {
          const byte = text.charCodeAt(i);
          if (byte === 0x07) {
            i += 1;
            break;
          }
          if (byte === 0x1b && text.charCodeAt(i + 1) === 0x5c) {
            i += 2;
            break;
          }
          i += 1;
        }
        continue;
      }

      let cursor = i + 1;
      while (cursor < text.length) {
        const byte = text.charCodeAt(cursor);
        if (byte >= 0x20 && byte <= 0x2f) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (cursor >= text.length) {
        i = text.length;
        continue;
      }
      if (text.charCodeAt(cursor) >= 0x30 && text.charCodeAt(cursor) <= 0x7e) {
        i = cursor + 1;
        continue;
      }

      i += 1;
      continue;
    }

    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x80 && code <= 0x9f)) {
      i += 1;
      continue;
    }

    safe += text[i];
    i += 1;
  }

  return safe;
}

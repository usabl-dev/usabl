/**
 * The first line of an error message, trimmed. A browser error's later lines can be its call log,
 * which can quote the element's markup and the row data in it, so a gap or a draft shows only this.
 */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

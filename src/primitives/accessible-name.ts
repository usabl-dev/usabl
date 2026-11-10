/**
 * An accessible name the way the browser reports it: each run of white space read as one space,
 * with none at either end. Only ASCII white space is collapsed, as HTML and CSS collapse it, so a
 * no-break space stays what it is.
 */
export function collapseWhiteSpace(name: string): string {
  return name.replace(/[\t\n\f\r ]+/gu, ' ').trim();
}

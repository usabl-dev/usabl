/**
 * An accessible name the way the browser reports it: each run of ASCII white space (tab, line
 * feed, form feed, carriage return, and space) read as one space, and none at either end. ASCII
 * white space is what HTML and CSS collapse. Any other character, such as a no-break space, stays
 * where it is, at either end too.
 */
export function collapseWhiteSpace(name: string): string {
  return name.replace(/[\t\n\f\r ]+/gu, ' ').replace(/^ | $/gu, '');
}

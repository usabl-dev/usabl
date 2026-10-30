// A minimal JSX factory that builds DOM nodes, so the fixture runs without React.
type Component = (props: Record<string, unknown>) => Node;

export function h(tag: string | Component, props: Record<string, unknown> | null, ...children: unknown[]): Node {
  if (typeof tag === 'function') {
    return tag({ ...(props ?? {}), children });
  }
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') {
      element.setAttribute(name, String(value));
    }
  }
  for (const child of children.flat()) {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

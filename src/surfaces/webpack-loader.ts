/**
 * The webpack loader behind the overlay's source location attributes.
 *
 * It holds no logic of its own. The plugin stores the one transform, the same one the Vite plugin
 * uses, on the compiler under a shared symbol, and this loader hands each module to it. Keeping the
 * loader free of imports means webpack can load it straight from the published package, and the
 * transform keeps a single definition. Loader options are not used for this on purpose: a function
 * in loader options cannot be written to webpack's persistent cache.
 *
 * When no transform is found, for example in a worker thread that has no compiler, the module is
 * returned unchanged. A missing source hint is a small loss; a failed build is not.
 *
 * The plugin adds this loader only when webpack runs in development mode, so a production build
 * never runs it at all.
 */

interface LoaderCompiler {
  [key: symbol]: unknown;
  parentCompilation?: { compiler?: LoaderCompiler };
}

interface LoaderContext {
  resourcePath: string;
  _compiler?: LoaderCompiler;
}

// The same key the plugin writes. Symbol.for gives one symbol per process, so the loader and the
// plugin agree on it without importing each other.
const SOURCE_TRANSFORM_KEY = Symbol.for('usabl.webpack.sourceTransform');

export default function usablSourceLoader(this: LoaderContext, source: string): string {
  // A child compiler, such as the one an HTML plugin starts, has its own compiler object. Walk up
  // to the compiler the plugin was applied to.
  let compiler = this._compiler;
  while (compiler !== undefined) {
    const transform = compiler[SOURCE_TRANSFORM_KEY];
    if (typeof transform === 'function') {
      const out: unknown = transform(source, this.resourcePath);
      return typeof out === 'string' ? out : source;
    }
    compiler = compiler.parentCompilation?.compiler;
  }
  return source;
}

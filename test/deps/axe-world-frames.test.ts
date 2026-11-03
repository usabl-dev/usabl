/**
 * The frame walk of the isolated axe run, over a stand-in page and its CDP sessions, so no browser
 * starts. Every frame is checked, or disclosed as a frame axe could not check, or skipped because
 * axe skips it as hidden. A frame that changes under the run, a result that is not a result, and a
 * frame axe never found are disclosed, never dropped.
 */
import { describe, expect, it } from 'vitest';
import { runAxeInIsolatedWorld } from '../../src/deps/axe-world.js';
import { FakeModel, fakePage, type FakeFrame, type FakeHooks } from '../support/fake-axe-frames.js';

const TOP: FakeFrame = { id: 'top', url: 'https://app.test/page', process: 'a' };

function run(frames: FakeFrame[], hooks: FakeHooks = {}): { model: FakeModel; result: ReturnType<typeof runAxeInIsolatedWorld> } {
  const model = new FakeModel(frames, hooks);
  const { pw, cdp } = fakePage(model);
  return { model, result: runAxeInIsolatedWorld(pw, cdp, {}, { stepTimeoutMs: 2_000 }) };
}

const NOT_REACHED = 'axe did not reach it, as for a frame in a closed shadow root or one added while axe ran';
const CHANGED = 'its frames changed while axe ran, so usabl could not tell which results came from which frame';

describe('the isolated axe run: every frame is checked', () => {
  it('checks each frame of a chain that leaves the top process and comes back to it', async () => {
    const { model, result } = run([
      TOP,
      { id: 'b', url: 'https://other.test/b', process: 'b', parent: 'top' },
      { id: 'a2', url: 'https://app.test/a2', process: 'a', parent: 'b' },
      { id: 'same', url: 'https://app.test/same', process: 'a', parent: 'top' },
    ]);
    const outcome = await result;
    expect(outcome.uncheckedFrames).toEqual([]);
    expect(model.calls.filter((call) => call.endsWith(':runPartial')).sort()).toEqual(['a2:runPartial', 'b:runPartial', 'same:runPartial', 'top:runPartial']);
    // Every session opened for a frame in another process is closed.
    expect([...new Set(model.detached)].sort()).toEqual([...new Set(model.opened)].sort());
  });

  it('skips a frame axe skips as hidden, with no gap', async () => {
    const { result } = run([TOP, { id: 'hidden', url: 'https://app.test/hidden', process: 'a', parent: 'top', hidden: true }]);
    expect((await result).uncheckedFrames).toEqual([]);
  });
});

describe('the isolated axe run: a frame that fails is disclosed', () => {
  it('discloses a frame removed while axe checks the frame before it', async () => {
    const { result } = run(
      [TOP, { id: 'first', url: 'https://app.test/first', process: 'a', parent: 'top' }, { id: 'gone', url: 'https://app.test/gone', process: 'a', parent: 'top' }],
      {
        beforeCall: (frame, call, model) => {
          if (frame.id === 'first' && call === 'runPartial') model.remove('gone');
        },
      },
    );
    expect((await result).uncheckedFrames).toEqual([{ origin: 'an unnamed frame', why: 'its frame was removed before axe reached it' }]);
  });

  it('discloses a frame whose element axe could not take as its run ended', async () => {
    const { result } = run([
      { ...TOP, partial: () => ({ results: [], frames: [{ ancestry: ['#nowhere'] }], environmentData: {} }) },
      { id: 'nowhere-else', url: 'https://app.test/x', process: 'a', parent: 'top', owner: 'object' },
    ], { frameContexts: (frame) => (frame.id === 'top' ? [{ frameSelector: '#nowhere', frameContext: {} }] : undefined) });
    expect((await result).uncheckedFrames).toEqual([
      { origin: 'an unnamed frame', why: 'its frame element was gone before axe reached it' },
      { origin: 'https://app.test', why: 'it is a document in an object or embed element, which axe does not check' },
    ]);
  });

  it('discloses a frame in another process that no session reaches', async () => {
    const { result } = run([TOP, { id: 'far', url: 'https://other.test/far', process: 'b', parent: 'top', noSession: true }]);
    expect((await result).uncheckedFrames).toEqual([{ origin: 'an unnamed frame', why: 'it runs in another process and usabl found no session for it' }]);
  });

  it('discloses a frame that navigates while axe runs in it', async () => {
    const { result } = run([TOP, { id: 'moving', url: 'https://app.test/moving', process: 'a', parent: 'top' }], {
      beforeCall: (frame, call, model) => {
        if (frame.id === 'moving' && call === 'runPartial') model.navigate('moving');
      },
    });
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://app.test', why: 'axe failed in it: Execution context was destroyed.' }]);
  });

  it('discloses a child frame whose partial result is not an object, never reads it as a frame with no findings', async () => {
    for (const partial of [undefined, null, 'clean', [], { results: [] }]) {
      const { result } = run([TOP, { id: 'odd', url: 'https://app.test/odd', process: 'a', parent: 'top', partial: () => partial }]);
      expect((await result).uncheckedFrames).toEqual([{ origin: 'https://app.test', why: 'axe returned no result in it' }]);
    }
  });

  it('discloses a child frame where usabl could not hand axe the semantics custom elements set', async () => {
    const { result } = run([TOP, { id: 'ce', url: 'https://app.test/ce', process: 'a', parent: 'top' }], {
      customElements: () => 1,
      installFails: (frame) => frame.id === 'ce',
    });
    expect((await result).uncheckedFrames).toEqual([
      { origin: 'https://app.test', why: 'usabl could not hand axe the semantics custom elements set: TypeError: install failed' },
    ]);
  });
});

describe('the isolated axe run: a frame that stops answering', () => {
  it('discloses only that frame, and still compares the rest of the page with the frame trees', async () => {
    const model = new FakeModel([
      TOP,
      { id: 'busy', url: 'https://busy.test/x', process: 'b', parent: 'top', hangs: true },
      { id: 'closed', url: 'https://forms.test/f', process: 'a', parent: 'top', owner: 'closed-shadow-iframe' },
    ]);
    const { pw, cdp } = fakePage(model);
    const outcome = await runAxeInIsolatedWorld(pw, cdp, {}, { stepTimeoutMs: 100 });
    expect(outcome.uncheckedFrames).toEqual([
      { origin: 'https://busy.test', why: 'creating a world for axe took longer than 100 ms' },
      { origin: 'https://forms.test', why: NOT_REACHED },
    ]);
    // The frame that stopped answering is never opened a second time.
    expect(model.opened.filter((id) => id === 'busy')).toHaveLength(1);
  });
});

describe('the isolated axe run: a top frame that fails fails the run', () => {
  it('refuses a top frame partial result that is not an object', async () => {
    const { result } = run([{ ...TOP, partial: () => undefined }]);
    await expect(result).rejects.toThrow('axe could not run on the page: axe returned no result in it');
  });

  it('refuses a final result that is not an axe result, never maps it to empty buckets', async () => {
    for (const finish of ['clean', [], { violations: 'none', incomplete: [], passes: [], inapplicable: [] }, { violations: [] }]) {
      const { result } = run([TOP], { finish: () => finish });
      await expect(result).rejects.toThrow('axe finished its run on the page with no result usabl could read');
    }
  });

  it('fails the run when usabl could not hand axe the semantics custom elements set in the top frame', async () => {
    const { result } = run([TOP], { customElements: () => 2, installFails: () => true });
    await expect(result).rejects.toThrow('axe could not run on the page: usabl could not hand axe the semantics custom elements set');
  });
});

describe('the isolated axe run: frames that change under the run', () => {
  it('discloses a child frame whose frame list differs between the two reads axe makes', async () => {
    const { result } = run(
      [TOP, { id: 'c', url: 'https://app.test/c', process: 'a', parent: 'top' }, { id: 'g', url: 'https://app.test/g', process: 'a', parent: 'c' }],
      { frameContexts: (frame, read) => (frame.id === 'c' && read === 1 ? [] : undefined) },
    );
    // The grandchild sits under the disclosed frame, so the one gap covers it.
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://app.test', why: CHANGED }]);
  });

  it('checks each frame it listed when the page adds a frame before it while the frames are checked', async () => {
    const { model, result } = run([TOP, { id: 'c1', url: 'https://app.test/c1', process: 'a', parent: 'top' }, { id: 'c2', url: 'https://app.test/c2', process: 'a', parent: 'top' }], {
      beforeCall: (frame, call, current) => {
        if (frame.id === 'c1' && call === 'runPartial') current.frames.set('added', { id: 'added', url: 'https://added.test/x', process: 'a', parent: 'top' });
      },
    });
    // The second listed frame is still the one checked second; the added one is disclosed.
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://added.test', why: NOT_REACHED }]);
    expect(model.calls.filter((call) => call.endsWith(':runPartial'))).toEqual(['top:runPartial', 'c1:runPartial', 'c2:runPartial']);
  });

  it('fails the run when the top frame list differs from the one axe ran with', async () => {
    const { result } = run([TOP, { id: 'c', url: 'https://app.test/c', process: 'a', parent: 'top' }], {
      frameContexts: (frame, read) => (frame.id === 'top' && read === 1 ? [{ frameSelector: '#new', frameContext: {} }, { frameSelector: '#c', frameContext: {} }] : undefined),
    });
    await expect(result).rejects.toThrow(`axe could not run on the page: ${CHANGED}`);
  });

  it('discloses a frame selector that reaches a frame axe already checked', async () => {
    const twice = [{ frameSelector: '#c', frameContext: {} }, { frameSelector: '#c', frameContext: {} }];
    const { result } = run(
      [{ ...TOP, partial: () => ({ results: [], frames: [{ ancestry: ['#c'] }, { ancestry: ['#c'] }], environmentData: {} }) }, { id: 'c', url: 'https://app.test/c', process: 'a', parent: 'top' }],
      { frameContexts: (frame) => (frame.id === 'top' ? twice : undefined) },
    );
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://app.test', why: 'its frame element changed while axe ran' }]);
  });
});

describe('the isolated axe run: frames axe never finds', () => {
  it('discloses an iframe in a closed shadow root', async () => {
    const { result } = run([TOP, { id: 'closed', url: 'https://forms.test/f', process: 'a', parent: 'top', owner: 'closed-shadow-iframe' }]);
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://forms.test', why: NOT_REACHED }]);
  });

  it('discloses a document in an object or an embed element', async () => {
    const { result } = run([
      TOP,
      { id: 'obj', url: 'https://app.test/obj', process: 'a', parent: 'top', owner: 'object' },
      { id: 'emb', url: 'https://app.test/emb', process: 'a', parent: 'top', owner: 'embed' },
    ]);
    const why = 'it is a document in an object or embed element, which axe does not check';
    expect((await result).uncheckedFrames).toEqual([
      { origin: 'https://app.test', why },
      { origin: 'https://app.test', why },
    ]);
  });

  it('skips a hidden frame axe never finds, as axe would', async () => {
    const { result } = run([TOP, { id: 'closed', url: 'https://forms.test/f', process: 'a', parent: 'top', owner: 'closed-shadow-iframe', hidden: true }]);
    expect((await result).uncheckedFrames).toEqual([]);
  });

  it('discloses a frame added inside a checked frame after axe read its frames', async () => {
    const { result } = run([TOP, { id: 'c', url: 'https://app.test/c', process: 'a', parent: 'top' }, { id: 'd', url: 'https://app.test/d', process: 'a', parent: 'top' }], {
      beforeCall: (frame, call, model) => {
        if (frame.id === 'd' && call === 'runPartial') {
          model.frames.set('late', { id: 'late', url: 'https://late.test/x', process: 'a', parent: 'c' });
        }
      },
    });
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://late.test', why: NOT_REACHED }]);
  });

  it('discloses a frame in another process that axe never found and no session reaches', async () => {
    const { result } = run([TOP, { id: 'lost', url: 'https://lost.test/x', process: 'b', parent: 'top', owner: 'closed-shadow-iframe', noSession: true }]);
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://lost.test', why: 'usabl could not reach it to tell whether axe checked it' }]);
  });

  it('discloses a frame axe never found inside a frame in another process', async () => {
    const { result } = run([
      TOP,
      { id: 'b', url: 'https://other.test/b', process: 'b', parent: 'top' },
      { id: 'inner', url: 'https://other.test/inner', process: 'b', parent: 'b', owner: 'closed-shadow-iframe' },
    ]);
    expect((await result).uncheckedFrames).toEqual([{ origin: 'https://other.test', why: NOT_REACHED }]);
  });
});

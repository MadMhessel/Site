import { StorageService } from '../src/storage.js';
import type { Snapshot } from '../src/types.js';

jest.mock('localforage', () => ({
  config: jest.fn(),
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined)
}));

describe('StorageService snapshots', () => {
  const createSnapshot = (value: string): Snapshot => ({
    timestamp: Date.now(),
    catalog: { products: [], categories: [] },
    content: { value }
  });

  it('pushes snapshots to undo stack', () => {
    const storage = new StorageService();
    storage.pushSnapshot(createSnapshot('one'));
    storage.pushSnapshot(createSnapshot('two'));
    expect(storage.popUndo()?.content.value).toBeDefined();
  });

  it('restores snapshot from redo stack', () => {
    const storage = new StorageService();
    const first = createSnapshot('first');
    const second = createSnapshot('second');
    storage.pushSnapshot(first);
    storage.pushSnapshot(second);
    storage.popUndo();
    const redo = storage.popRedo();
    expect(redo?.content.value).toBeDefined();
  });
});

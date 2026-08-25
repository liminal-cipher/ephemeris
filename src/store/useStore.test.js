import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './useStore';

describe('useStore', () => {
  beforeEach(() => {
    // Reset store before each test
    useStore.setState({ activePageId: null });
  });

  it('should initialize with activePageId as null', () => {
    const state = useStore.getState();
    expect(state.activePageId).toBeNull();
  });

  it('should set activePageId', () => {
    useStore.getState().setActivePageId(123);
    const state = useStore.getState();
    expect(state.activePageId).toBe(123);
  });
});

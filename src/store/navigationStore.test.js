import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from './navigationStore';

describe('navigation store', () => {
  beforeEach(() => {
    // Reset store before each test
    useNavigationStore.setState({ activePageId: null });
  });

  it('should initialise with activePageId as null', () => {
    const state = useNavigationStore.getState();
    expect(state.activePageId).toBeNull();
  });

  it('should set activePageId', () => {
    useNavigationStore.getState().setActivePageId(123);
    const state = useNavigationStore.getState();
    expect(state.activePageId).toBe(123);
  });
});

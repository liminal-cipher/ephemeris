import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Sidebar from './Sidebar';
import { useStore } from '../store/useStore';
import { workspacePages, useWorkspaceStore, createWorkspacePage } from '../store/workspace';

// Mock export/import
vi.mock('../utils/exportImport', () => ({
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn()
}));

describe('Sidebar Component', () => {
  beforeEach(() => {
    // Clear Yjs map
    Array.from(workspacePages.keys()).forEach(key => workspacePages.delete(key));
    useWorkspaceStore.setState({ isSynced: true, pages: {} });
    useStore.setState({ activePageId: null });
  });

  it('renders "My Workspace"', () => {
    render(<Sidebar />);
    expect(screen.getByText('My Workspace')).toBeInTheDocument();
  });

  it('renders a list of pages from the workspace', async () => {
    workspacePages.set('1', { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 });
    workspacePages.set('2', { title: 'Page 2', parentId: null, createdAt: 2, updatedAt: 2 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);
    
    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 2')).toBeInTheDocument();
    });
  });

  it('creates a new page when New Page is clicked', async () => {
    render(<Sidebar />);
    
    const newPageBtn = screen.getByText('New Page');
    fireEvent.click(newPageBtn);
    
    await waitFor(() => {
      const keys = Array.from(workspacePages.keys());
      expect(keys.length).toBe(1);
    });
  });

  it('filters pages based on search query', async () => {
    workspacePages.set('1', { title: 'Apple', parentId: null, createdAt: 1, updatedAt: 1 });
    workspacePages.set('2', { title: 'Banana', parentId: null, createdAt: 2, updatedAt: 2 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);
    
    await waitFor(() => {
      expect(screen.getByText('Apple')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search pages...');
    fireEvent.change(searchInput, { target: { value: 'Ban' } });

    await waitFor(() => {
      expect(screen.queryByText('Apple')).not.toBeInTheDocument();
      expect(screen.getByText('Banana')).toBeInTheDocument();
    });
  });

  it('deletes a page when delete button is clicked and confirmed', async () => {
    vi.spyOn(window, 'confirm').mockImplementation(() => true);
    workspacePages.set('1', { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTitle('Delete page');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(workspacePages.has('1')).toBe(false);
    });
    vi.restoreAllMocks();
  });

  it('supports multi-selection with Shift key', async () => {
    workspacePages.set('1', { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 });
    workspacePages.set('2', { title: 'Page 2', parentId: null, createdAt: 2, updatedAt: 2 });
    workspacePages.set('3', { title: 'Page 3', parentId: null, createdAt: 3, updatedAt: 3 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 3')).toBeInTheDocument();
    });

    // Click Page 1 first
    fireEvent.click(screen.getByText('Page 1'));

    // Shift-click Page 3 to select 1, 2, and 3
    fireEvent.click(screen.getByText('Page 3'), { shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });
  });
});


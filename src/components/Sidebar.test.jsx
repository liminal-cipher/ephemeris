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

import GlobalDialogHost from './common/GlobalDialogHost';

describe('Sidebar Component', () => {
  beforeEach(() => {
    localStorage.clear();
  });
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

  it('deletes a page when delete button is clicked and confirmed via modal', async () => {
    workspacePages.set('1', { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(
      <>
        <Sidebar />
        <GlobalDialogHost />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTitle('Delete page');
    fireEvent.click(deleteBtn);

    // Custom modal should appear
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Delete Page')).toBeInTheDocument();
    });

    // Click confirm in custom modal
    const confirmBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(workspacePages.has('1')).toBe(false);
    });
  });

  it('skips confirmation when never ask again is stored', async () => {
    localStorage.setItem('ephemeris_skip_delete_confirm', 'true');
    workspacePages.set('1', { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(
      <>
        <Sidebar />
        <GlobalDialogHost />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTitle('Delete page');
    fireEvent.click(deleteBtn);

    // Should delete immediately without modal
    await waitFor(() => {
      expect(workspacePages.has('1')).toBe(false);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
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

  it('toggles collapsible sub-pages with chevron button', async () => {
    workspacePages.set('p1', { title: 'Parent Page', parentId: null, createdAt: 1, updatedAt: 1 });
    workspacePages.set('c1', { title: 'Child Page', parentId: 'p1', createdAt: 2, updatedAt: 2 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);

    await waitFor(() => {
      expect(screen.getByText('Parent Page')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByLabelText('Expand sub-pages');
    expect(toggleBtn).toBeInTheDocument();

    // Click to expand
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('Child Page')).toBeInTheDocument();
    });

    // Click to collapse
    const collapseBtn = screen.getByLabelText('Collapse sub-pages');
    fireEvent.click(collapseBtn);

    await waitFor(() => {
      expect(screen.queryByText('Child Page')).not.toBeInTheDocument();
    });
  });

  it('re-parents page on drop', async () => {
    workspacePages.set('p1', { title: 'Target Parent', parentId: null, createdAt: 1, updatedAt: 1 });
    workspacePages.set('p2', { title: 'Moving Note', parentId: null, createdAt: 2, updatedAt: 2 });
    useWorkspaceStore.setState({ pages: workspacePages.toJSON() });

    render(<Sidebar />);

    await waitFor(() => {
      expect(screen.getByText('Target Parent')).toBeInTheDocument();
      expect(screen.getByText('Moving Note')).toBeInTheDocument();
    });

    const targetItem = screen.getByText('Target Parent').closest('.sidebar-item');
    fireEvent.drop(targetItem, {
      dataTransfer: {
        getData: (type) => (type === 'text/plain' ? 'p2' : '')
      }
    });

    await waitFor(() => {
      const moved = workspacePages.get('p2');
      expect(moved.parentId).toBe('p1');
    });
  });

  it('triggers onToggleSidebar when collapse button is clicked', async () => {
    const handleToggle = vi.fn();
    render(<Sidebar onToggleSidebar={handleToggle} />);

    const collapseBtn = screen.getByLabelText('Collapse sidebar');
    expect(collapseBtn).toBeInTheDocument();
    fireEvent.click(collapseBtn);

    expect(handleToggle).toHaveBeenCalledTimes(1);
  });
});



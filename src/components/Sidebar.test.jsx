import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Sidebar from './Sidebar';
import { db } from '../db/db';
import { useStore } from '../store/useStore';

// Mock export/import
vi.mock('../utils/exportImport', () => ({
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn()
}));

describe('Sidebar Component', () => {
  beforeEach(async () => {
    await db.pages.clear();
    useStore.setState({ activePageId: null });
  });

  it('renders "My Workspace"', () => {
    render(<Sidebar />);
    expect(screen.getByText('My Workspace')).toBeInTheDocument();
  });

  it('renders a list of pages from the database', async () => {
    await db.pages.bulkAdd([
      { title: 'Page 1', parentId: null, createdAt: 1, updatedAt: 1 },
      { title: 'Page 2', parentId: null, createdAt: 2, updatedAt: 2 }
    ]);

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
    
    await waitFor(async () => {
      const count = await db.pages.count();
      expect(count).toBe(1);
    });
  });

  it('filters pages based on search query', async () => {
    await db.pages.bulkAdd([
      { title: 'Apple', parentId: null, createdAt: 1, updatedAt: 1 },
      { title: 'Banana', parentId: null, createdAt: 2, updatedAt: 2 }
    ]);

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
});

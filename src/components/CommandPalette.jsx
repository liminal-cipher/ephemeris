import React, { useState, useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../store/workspace';
import { useStore } from '../store/useStore';
import './CommandPalette.css';

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  
  const setActivePageId = useStore((state) => state.setActivePageId);
  const getPagesArray = useWorkspaceStore(state => state.getPagesArray);

  // Fetch all pages and filter by query
  const pages = getPagesArray();
  
  const filteredPages = pages.filter(page => {
    if (!query) return true;
    return (page.title || '').toLowerCase().includes(query.toLowerCase());
  });

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Global shortcut (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setQuery('');
    }
  }, [isOpen]);

  // Handle keyboard navigation within the palette
  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < filteredPages.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selectedPage = filteredPages[selectedIndex];
      if (selectedPage) {
        handleSelectPage(selectedPage.id);
      }
    }
  };

  const handleSelectPage = (id) => {
    setActivePageId(id);
    setIsOpen(false);
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={() => setIsOpen(false)}>
      <div className="command-palette-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Search pages... (Type to filter)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="command-palette-results">
          {filteredPages.length > 0 ? (
            filteredPages.map((page, index) => (
              <li
                key={page.id}
                className={index === selectedIndex ? 'selected' : ''}
                onClick={() => handleSelectPage(page.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                {page.emoji && <span>{page.emoji}</span>}
                <span>{page.title || 'Untitled'}</span>
              </li>
            ))
          ) : (
            <div className="command-palette-empty">No results found</div>
          )}
        </ul>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { usePagesList } from '../store/workspace';
import { useStore } from '../store/useStore';
import { FileText, Search } from 'lucide-react';
import './CommandPalette.css';

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  
  const setActivePageId = useStore((state) => state.setActivePageId);
  const pages = usePagesList();

  // Filter pages by title or emoji
  const filteredPages = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return pages;
    return pages.filter(page => {
      const title = (page.title || 'Untitled').toLowerCase();
      const emoji = page.emoji || '';
      return title.includes(trimmed) || emoji.includes(trimmed);
    });
  }, [pages, query]);

  // Reset index when query or filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filteredPages.length]);

  // Global shortcut (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(prev => !prev);
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle keyboard navigation within the palette
  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev < filteredPages.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredPages.length - 1));
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
    <div className="command-palette-overlay" onClick={() => setIsOpen(false)} role="dialog" aria-modal="true" aria-label="Command Palette">
      <div className="command-palette-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid var(--border-color)' }}>
          <Search size={18} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Search pages by title..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search pages"
            aria-autocomplete="list"
          />
        </div>
        <ul className="command-palette-results" role="listbox">
          {filteredPages.length > 0 ? (
            filteredPages.map((page, index) => (
              <li
                key={page.id}
                role="option"
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? 'selected' : ''}
                onClick={() => handleSelectPage(page.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="emoji" aria-hidden="true">{page.emoji || <FileText size={16} />}</span>
                <span className="title">{page.title || 'Untitled'}</span>
              </li>
            ))
          ) : (
            <div className="command-palette-empty" role="status">No pages found matching &ldquo;{query}&rdquo;</div>
          )}
        </ul>
      </div>
    </div>
  );
}


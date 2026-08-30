import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { usePagesList } from '../store/workspace';
import { useStore } from '../store/useStore';
import { extractTextFromJson } from '../utils/linkParser';
import { FileText, Search } from 'lucide-react';
import './CommandPalette.css';

function HighlightText({ text, query }) {
  if (!query || !text) return <>{text}</>;
  const trimmed = query.trim();
  if (!trimmed) return <>{text}</>;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = String(text).split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === trimmed.toLowerCase() ? (
          <strong key={i} className="search-highlight">{part}</strong>
        ) : (
          part
        )
      )}
    </>
  );
}

function getPlainText(contentStr) {
  if (!contentStr) return '';
  try {
    const json = JSON.parse(contentStr);
    return extractTextFromJson(json).replace(/\s+/g, ' ').trim();
  } catch {
    return typeof contentStr === 'string' ? contentStr.replace(/\s+/g, ' ').trim() : '';
  }
}

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  
  const setActivePageId = useStore((state) => state.setActivePageId);
  const pages = usePagesList();
  const dexiePages = useLiveQuery(() => db.pages.toArray(), []) || [];

  // Filter pages by title, emoji, and content
  const filteredResults = useMemo(() => {
    const trimmed = query.trim().toLowerCase();

    return pages.map(page => {
      const dexiePage = dexiePages.find(d => d.id === page.id || d.id === Number(page.id));
      const plainText = getPlainText(dexiePage?.content);
      const title = page.title || 'Untitled';
      const emoji = page.emoji || '';

      if (!trimmed) {
        return {
          ...page,
          title,
          snippet: plainText ? (plainText.slice(0, 90) + (plainText.length > 90 ? '...' : '')) : '',
          isContentMatch: false
        };
      }

      const titleMatch = title.toLowerCase().includes(trimmed);
      const emojiMatch = emoji.toLowerCase().includes(trimmed);
      const contentIndex = plainText.toLowerCase().indexOf(trimmed);
      const contentMatch = contentIndex !== -1;

      if (!titleMatch && !emojiMatch && !contentMatch) {
        return null;
      }

      let snippet = '';
      if (contentMatch) {
        const start = Math.max(0, contentIndex - 30);
        const end = Math.min(plainText.length, contentIndex + trimmed.length + 55);
        snippet = (start > 0 ? '...' : '') + plainText.slice(start, end) + (end < plainText.length ? '...' : '');
      } else if (plainText) {
        snippet = plainText.slice(0, 90) + (plainText.length > 90 ? '...' : '');
      }

      return {
        ...page,
        title,
        snippet,
        isContentMatch: contentMatch && !titleMatch
      };
    }).filter(Boolean);
  }, [pages, dexiePages, query]);

  // Reset index when query or filtered results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filteredResults.length]);

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
      setSelectedIndex(prev => (prev < filteredResults.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : filteredResults.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selectedPage = filteredResults[selectedIndex];
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
            placeholder="Search pages by title or content..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search pages"
            aria-autocomplete="list"
          />
        </div>
        <ul className="command-palette-results" role="listbox">
          {filteredResults.length > 0 ? (
            filteredResults.map((item, index) => (
              <li
                key={item.id}
                role="option"
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? 'selected' : ''}
                onClick={() => handleSelectPage(item.id)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="command-palette-item-icon" aria-hidden="true">
                  {item.emoji || <FileText size={16} />}
                </span>
                <div className="command-palette-item-details">
                  <div className="command-palette-item-title">
                    <HighlightText text={item.title} query={query} />
                  </div>
                  {item.snippet && (
                    <div className="command-palette-item-snippet">
                      <HighlightText text={item.snippet} query={query} />
                    </div>
                  )}
                </div>
              </li>
            ))
          ) : (
            <div className="command-palette-empty" role="status">
              No pages found matching &ldquo;{query}&rdquo;
            </div>
          )}
        </ul>
      </div>
    </div>
  );
}


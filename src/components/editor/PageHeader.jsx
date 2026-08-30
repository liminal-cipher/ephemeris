import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Image as ImageIcon, Smile, Search } from 'lucide-react'
import { updateWorkspacePage } from '../../store/workspace'
import { EMOJI_CATEGORIES, ALL_EMOJIS } from './emojiData'

// Extract first grapheme (compound emoji aware)
function extractFirstEmoji(str) {
  if (!str) return '';
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(str.trim()));
    return segments[0]?.segment || '';
  } catch {
    return Array.from(str.trim())[0] || '';
  }
}

export default function PageHeader({ activePageId, title, emoji, coverImage, titleInputRef, editor }) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiSearch, setEmojiSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('all')
  const emojiInputRef = useRef(null)

  const updatePage = (changes) => {
    if (activePageId) {
      updateWorkspacePage(activePageId, changes)
    }
  }

  const handleCoverUpload = (e) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = reader.result
        updatePage({ coverImage: base64 })
      }
      reader.readAsDataURL(file)
    }
  }

  // Focus custom input when popover opens
  useEffect(() => {
    if (showEmojiPicker) {
      setEmojiSearch('')
      setActiveCategory('all')
      const timer = setTimeout(() => {
        emojiInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [showEmojiPicker])

  // Handle custom emoji input (typing, pasting, or OS emoji keyboard)
  const handleCustomInput = (val) => {
    setEmojiSearch(val)
    const detected = extractFirstEmoji(val)
    if (detected && (detected.length > 1 || detected.codePointAt(0) > 255)) {
      updatePage({ emoji: detected })
      setShowEmojiPicker(false)
    }
  }

  // Filtered categorized emojis
  const displayCategories = useMemo(() => {
    const trimmed = emojiSearch.trim()
    if (trimmed) {
      const matched = ALL_EMOJIS.filter(em => em.includes(trimmed))
      return [{ name: 'Search Results', id: 'search', emojis: matched }]
    }

    if (activeCategory === 'all') {
      return EMOJI_CATEGORIES
    }

    return EMOJI_CATEGORIES.filter(cat => cat.id === activeCategory)
  }, [emojiSearch, activeCategory])

  return (
    <>
      {coverImage && (
        <div className="cover-image-container">
          <img src={coverImage} alt="Page cover" className="cover-image" />
          <button 
            className="change-cover-btn" 
            onClick={() => updatePage({ coverImage: '' })}
            aria-label="Remove cover image"
          >
            Remove Cover
          </button>
        </div>
      )}
      
      {!coverImage && (
        <div className="page-actions-top" role="toolbar" aria-label="Page actions">
          <label className="page-action-btn" tabIndex="0" role="button" aria-label="Add cover image">
            <ImageIcon size={16} aria-hidden="true" /> Add cover
            <input type="file" accept="image/*" hidden onChange={handleCoverUpload} />
          </label>
          {!emoji && (
            <button 
              className="page-action-btn" 
              onClick={() => setShowEmojiPicker(true)}
              aria-label="Add icon"
              aria-expanded={showEmojiPicker}
            >
              <Smile size={16} aria-hidden="true" /> Add icon
            </button>
          )}
        </div>
      )}

      <div className="page-header" style={{ position: 'relative' }}>
        {emoji && (
          <div 
            className="page-emoji" 
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            role="button"
            tabIndex="0"
            aria-label="Change page icon"
            aria-expanded={showEmojiPicker}
          >
            {emoji}
          </div>
        )}
        
        {showEmojiPicker && (
          <div className="emoji-picker-popover" role="dialog" aria-label="Emoji picker">
            <div className="emoji-custom-input-wrapper">
              <Search size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
              <input
                ref={emojiInputRef}
                type="text"
                className="emoji-custom-input"
                placeholder="Search or paste emoji..."
                value={emojiSearch}
                onChange={(e) => handleCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const detected = extractFirstEmoji(emojiSearch)
                    if (detected) {
                      updatePage({ emoji: detected })
                      setShowEmojiPicker(false)
                    }
                  } else if (e.key === 'Escape') {
                    setShowEmojiPicker(false)
                  }
                }}
                aria-label="Search or paste emoji"
              />
            </div>

            <div className="emoji-category-tabs">
              <button
                className={`emoji-category-tab ${activeCategory === 'all' ? 'is-active' : ''}`}
                onClick={() => { setActiveCategory('all'); setEmojiSearch(''); }}
                title="All Emojis (1400+)"
              >
                ⭐️
              </button>
              {EMOJI_CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  className={`emoji-category-tab ${activeCategory === cat.id ? 'is-active' : ''}`}
                  onClick={() => { setActiveCategory(cat.id); setEmojiSearch(''); }}
                  title={cat.name}
                >
                  {cat.icon}
                </button>
              ))}
            </div>

            <div className="emoji-picker-hint">Press Win + . (Windows) or Cmd + Ctrl + Space (Mac)</div>
            
            <div className="emoji-grid-container">
              {displayCategories.map(cat => (
                <div key={cat.id || cat.name} style={{ marginBottom: '8px' }}>
                  <div className="emoji-category-header">{cat.name} ({cat.emojis.length})</div>
                  <div className="emoji-grid" role="listbox">
                    {cat.emojis.map((em, idx) => (
                      <button 
                        key={idx} 
                        className={`emoji-btn ${emoji === em ? 'is-active' : ''}`}
                        role="option"
                        aria-selected={emoji === em}
                        onClick={() => { updatePage({ emoji: em }); setShowEmojiPicker(false); }}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', borderTop: '1px solid var(--border-color)', paddingTop: '6px' }}>
              <button className="emoji-picker-action" onClick={() => { updatePage({ emoji: '' }); setShowEmojiPicker(false); }}>Remove</button>
              <button className="emoji-picker-action" onClick={() => setShowEmojiPicker(false)}>Close</button>
            </div>
          </div>
        )}
        
        <input 
          ref={titleInputRef}
          className="page-title-input" 
          value={title} 
          onChange={(e) => updatePage({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (editor) {
                editor.commands.focus()
              }
            }
          }}
          placeholder="Untitled"
          aria-label="Page title"
        />
      </div>
    </>
  )
}




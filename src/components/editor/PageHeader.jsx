import React, { useState, useMemo, useRef, useEffect } from 'react'
import { Image as ImageIcon, Smile, Search, Upload, Link as LinkIcon } from 'lucide-react'
import { updateWorkspacePage } from '../../store/workspace'
import { EMOJI_CATEGORIES, ALL_EMOJIS } from './emojiData'
import PageIcon, { isImageIcon } from '../common/PageIcon'

const UNSPLASH_PRESETS = [
  'https://images.unsplash.com/photo-1506744626753-1396e00185c6?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1511884642898-4c92249e20b6?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1473448912268-2022ce9509d8?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1513531926349-466f15ec8ce7?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?q=80&w=1200&auto=format&fit=crop',
  'https://images.unsplash.com/photo-1507608616759-54f48f0af0ee?q=80&w=1200&auto=format&fit=crop'
]

// Extract first grapheme (compound emoji aware)
function extractFirstEmoji(str) {
  if (!str) return '';
  if (isImageIcon(str)) return str;
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
  const [showCoverPicker, setShowCoverPicker] = useState(false)
  const [mainTab, setMainTab] = useState('emojis') // 'emojis' | 'custom' | 'image'
  const [coverTab, setCoverTab] = useState('gallery') // 'gallery' | 'upload' | 'link'
  const [emojiSearch, setEmojiSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('smileys')
  const [iconUrlInput, setIconUrlInput] = useState('')
  const [coverUrlInput, setCoverUrlInput] = useState('')
  const emojiInputRef = useRef(null)
  const iconFileInputRef = useRef(null)
  const coverFileInputRef = useRef(null)

  // Custom Saved Emoji & Icon Library from localStorage
  const [customLibrary, setCustomLibrary] = useState(() => {
    try {
      const saved = localStorage.getItem('ephemeris_custom_emojis');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const addToLibrary = (newEmoji) => {
    if (!newEmoji) return;
    setCustomLibrary(prev => {
      if (prev.includes(newEmoji)) return prev;
      const updated = [newEmoji, ...prev];
      try {
        localStorage.setItem('ephemeris_custom_emojis', JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to save emoji to library:', err);
      }
      return updated;
    });
  };

  const removeFromLibrary = (targetEmoji, e) => {
    e.stopPropagation();
    setCustomLibrary(prev => {
      const updated = prev.filter(em => em !== targetEmoji);
      try {
        localStorage.setItem('ephemeris_custom_emojis', JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to update emoji library:', err);
      }
      return updated;
    });
  };

  const updatePage = (changes) => {
    if (activePageId) {
      updateWorkspacePage(activePageId, changes)
    }
  }

  const handleCoverUpload = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = reader.result
        updatePage({ coverImage: base64 })
        setShowCoverPicker(false)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleCoverUrlSubmit = (e) => {
    e.preventDefault()
    const trimmed = coverUrlInput.trim()
    if (trimmed) {
      updatePage({ coverImage: trimmed })
      setCoverUrlInput('')
      setShowCoverPicker(false)
    }
  }

  const getRandomCover = () => {
    const randomIndex = Math.floor(Math.random() * UNSPLASH_PRESETS.length)
    updatePage({ coverImage: UNSPLASH_PRESETS[randomIndex] })
  }

  // Handle custom image file upload for icon
  const handleIconFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      const reader = new FileReader()
      reader.onloadend = () => {
        const base64 = reader.result
        updatePage({ emoji: base64 })
        addToLibrary(base64)
        setShowEmojiPicker(false)
      }
      reader.readAsDataURL(file)
    }
  }

  // Handle custom image URL submission
  const handleIconUrlSubmit = (e) => {
    e.preventDefault()
    const trimmed = iconUrlInput.trim()
    if (trimmed) {
      updatePage({ emoji: trimmed })
      addToLibrary(trimmed)
      setIconUrlInput('')
      setShowEmojiPicker(false)
    }
  }

  // Focus custom input when popover opens
  useEffect(() => {
    if (showEmojiPicker) {
      setEmojiSearch('')
      setIconUrlInput('')
      setMainTab('emojis')
      setActiveCategory('smileys')
      const timer = setTimeout(() => {
        emojiInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [showEmojiPicker])

  const candidateEmoji = useMemo(() => {
    const detected = extractFirstEmoji(emojiSearch);
    if (detected && (detected.length > 1 || detected.codePointAt(0) > 255 || isImageIcon(detected))) {
      return detected;
    }
    return '';
  }, [emojiSearch]);

  // Current category data
  const currentCategoryData = useMemo(() => {
    return EMOJI_CATEGORIES.find(cat => cat.id === activeCategory) || EMOJI_CATEGORIES[0];
  }, [activeCategory]);

  // Filtered emojis for search
  const searchResults = useMemo(() => {
    const trimmed = emojiSearch.trim();
    if (!trimmed) return null;
    const allPool = [...customLibrary, ...ALL_EMOJIS];
    return [...new Set(allPool.filter(em => em.includes(trimmed)))];
  }, [emojiSearch, customLibrary]);

  return (
    <>
      {coverImage && (
        <div className="cover-image-container">
          <img src={coverImage} alt="Page cover" className="cover-image" />
          <div className="cover-actions-overlay">
            <button 
              className="change-cover-btn" 
              onClick={() => setShowCoverPicker(!showCoverPicker)}
              aria-label="Change cover image"
            >
              Change Cover
            </button>
            <button 
              className="change-cover-btn remove-cover-btn" 
              onClick={() => updatePage({ coverImage: '' })}
              aria-label="Remove cover image"
            >
              Remove
            </button>
          </div>
        </div>
      )}
      
      {!coverImage && (
        <div className="page-actions-top" role="toolbar" aria-label="Page actions">
          <button 
            className="page-action-btn" 
            onClick={getRandomCover}
            aria-label="Add cover image"
          >
            <ImageIcon size={16} aria-hidden="true" /> Add cover
          </button>
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

      {showCoverPicker && (
        <div className="cover-picker-popover" role="dialog" aria-label="Cover picker">
          <div className="emoji-main-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={coverTab === 'gallery'}
              className={`emoji-main-tab ${coverTab === 'gallery' ? 'is-active' : ''}`}
              onClick={() => setCoverTab('gallery')}
            >
              Gallery
            </button>
            <button
              role="tab"
              aria-selected={coverTab === 'upload'}
              className={`emoji-main-tab ${coverTab === 'upload' ? 'is-active' : ''}`}
              onClick={() => setCoverTab('upload')}
            >
              Upload
            </button>
            <button
              role="tab"
              aria-selected={coverTab === 'link'}
              className={`emoji-main-tab ${coverTab === 'link' ? 'is-active' : ''}`}
              onClick={() => setCoverTab('link')}
            >
              Link
            </button>
          </div>

          <div className="emoji-grid-container" style={{ maxHeight: '300px', marginTop: '0.5rem' }}>
            {coverTab === 'gallery' && (
              <div className="cover-gallery-grid">
                {UNSPLASH_PRESETS.map((url, idx) => (
                  <button
                    key={idx}
                    className="cover-gallery-item"
                    onClick={() => {
                      updatePage({ coverImage: url })
                      setShowCoverPicker(false)
                    }}
                  >
                    <img src={url} alt={`Cover preset ${idx + 1}`} loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            
            {coverTab === 'upload' && (
              <div className="custom-icon-upload-panel">
                <div className="custom-icon-group">
                  <span className="custom-icon-label">Upload Image File</span>
                  <button 
                    type="button" 
                    className="custom-icon-upload-trigger"
                    onClick={() => coverFileInputRef.current?.click()}
                  >
                    <Upload size={15} aria-hidden="true" /> Choose an image
                  </button>
                  <input 
                    ref={coverFileInputRef}
                    type="file" 
                    accept="image/*" 
                    style={{ display: 'none' }}
                    onChange={handleCoverUpload}
                  />
                  <span className="custom-icon-hint">Recommended size: 1500x600 pixels</span>
                </div>
              </div>
            )}

            {coverTab === 'link' && (
              <form onSubmit={handleCoverUrlSubmit} className="custom-icon-upload-panel" style={{ paddingTop: '1rem' }}>
                <span className="custom-icon-label">Image URL</span>
                <div className="emoji-custom-input-wrapper">
                  <LinkIcon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
                  <input 
                    type="url" 
                    placeholder="https://example.com/cover.jpg"
                    value={coverUrlInput}
                    onChange={(e) => setCoverUrlInput(e.target.value)}
                    className="emoji-custom-input"
                    aria-label="Image cover URL"
                  />
                  <button 
                    type="submit" 
                    className="emoji-save-btn" 
                    disabled={!coverUrlInput.trim()}
                  >
                    Apply
                  </button>
                </div>
              </form>
            )}
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '6px', marginTop: '6px' }}>
            <button className="emoji-picker-action" onClick={() => setShowCoverPicker(false)}>Close</button>
          </div>
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
            <PageIcon icon={emoji} size={48} className="page-header-icon" />
          </div>
        )}
        
        {showEmojiPicker && (
          <div className="emoji-picker-popover" role="dialog" aria-label="Icon picker">
            <div className="emoji-main-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={mainTab === 'emojis'}
                className={`emoji-main-tab ${mainTab === 'emojis' ? 'is-active' : ''}`}
                onClick={() => { setMainTab('emojis'); setEmojiSearch(''); }}
              >
                Emojis
              </button>
              <button
                role="tab"
                aria-selected={mainTab === 'custom'}
                className={`emoji-main-tab ${mainTab === 'custom' ? 'is-active' : ''}`}
                onClick={() => { setMainTab('custom'); setEmojiSearch(''); }}
              >
                Custom Library {customLibrary.length > 0 && `(${customLibrary.length})`}
              </button>
              <button
                role="tab"
                aria-selected={mainTab === 'image'}
                className={`emoji-main-tab ${mainTab === 'image' ? 'is-active' : ''}`}
                onClick={() => { setMainTab('image'); setEmojiSearch(''); }}
              >
                Upload / Link
              </button>
            </div>

            {mainTab !== 'image' && (
              <div className="emoji-custom-input-wrapper">
                <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
                <input
                  ref={emojiInputRef}
                  type="text"
                  className="emoji-custom-input"
                  placeholder={mainTab === 'custom' ? "Paste or type emoji to save..." : "Search emojis..."}
                  value={emojiSearch}
                  onChange={(e) => setEmojiSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && candidateEmoji) {
                      addToLibrary(candidateEmoji);
                      updatePage({ emoji: candidateEmoji });
                      setShowEmojiPicker(false);
                    } else if (e.key === 'Escape') {
                      setShowEmojiPicker(false);
                    }
                  }}
                  aria-label="Search or paste emoji"
                />
                {candidateEmoji && (
                  <button
                    className="emoji-save-btn"
                    onClick={() => {
                      addToLibrary(candidateEmoji);
                      updatePage({ emoji: candidateEmoji });
                      setShowEmojiPicker(false);
                    }}
                    title="Save to custom library and set as icon"
                  >
                    + Save
                  </button>
                )}
              </div>
            )}

            {mainTab === 'emojis' && !searchResults && (
              <div className="emoji-category-tabs" role="tablist" aria-label="Emoji categories">
                {EMOJI_CATEGORIES.map(cat => (
                  <button
                    key={cat.id}
                    role="tab"
                    aria-selected={activeCategory === cat.id}
                    className={`emoji-category-tab ${activeCategory === cat.id ? 'is-active' : ''}`}
                    onClick={() => setActiveCategory(cat.id)}
                    title={cat.name}
                  >
                    {cat.icon}
                  </button>
                ))}
              </div>
            )}
            
            <div className="emoji-grid-container">
              {mainTab === 'image' ? (
                <div className="custom-icon-upload-panel">
                  <div className="custom-icon-group">
                    <span className="custom-icon-label">Upload Image File</span>
                    <button 
                      type="button" 
                      className="custom-icon-upload-trigger"
                      onClick={() => iconFileInputRef.current?.click()}
                    >
                      <Upload size={15} aria-hidden="true" /> Choose an image
                    </button>
                    <input 
                      ref={iconFileInputRef}
                      type="file" 
                      accept="image/*" 
                      style={{ display: 'none' }}
                      onChange={handleIconFileUpload}
                    />
                    <span className="custom-icon-hint">PNG, JPG, SVG, WebP, GIF (recommended square)</span>
                  </div>

                  <div className="custom-icon-divider">or</div>

                  <form onSubmit={handleIconUrlSubmit} className="custom-icon-url-form">
                    <span className="custom-icon-label">Image URL</span>
                    <div className="emoji-custom-input-wrapper">
                      <LinkIcon size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden="true" />
                      <input 
                        type="url" 
                        placeholder="https://example.com/icon.png"
                        value={iconUrlInput}
                        onChange={(e) => setIconUrlInput(e.target.value)}
                        className="emoji-custom-input"
                        aria-label="Image icon URL"
                      />
                      <button 
                        type="submit" 
                        className="emoji-save-btn" 
                        disabled={!iconUrlInput.trim()}
                      >
                        Apply
                      </button>
                    </div>
                  </form>
                </div>
              ) : searchResults ? (
                <div>
                  <div className="emoji-category-header">Search Results ({searchResults.length})</div>
                  {searchResults.length > 0 ? (
                    <div className="emoji-grid" role="listbox">
                      {searchResults.map((em, idx) => (
                        <button 
                          key={idx} 
                          className={`emoji-btn ${emoji === em ? 'is-active' : ''}`}
                          role="option"
                          aria-selected={emoji === em}
                          onClick={() => { updatePage({ emoji: em }); setShowEmojiPicker(false); }}
                        >
                          <PageIcon icon={em} size={20} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="emoji-empty-state">No emojis found matching &ldquo;{emojiSearch}&rdquo;</div>
                  )}
                </div>
              ) : mainTab === 'custom' ? (
                <div>
                  <div className="emoji-category-header">Saved Emojis &amp; Icons ({customLibrary.length})</div>
                  {customLibrary.length > 0 ? (
                    <div className="emoji-grid" role="listbox">
                      {customLibrary.map((em, idx) => (
                        <div key={idx} className="emoji-saved-item">
                          <button 
                            className={`emoji-btn ${emoji === em ? 'is-active' : ''}`}
                            role="option"
                            aria-selected={emoji === em}
                            onClick={() => { updatePage({ emoji: em }); setShowEmojiPicker(false); }}
                          >
                            <PageIcon icon={em} size={20} />
                          </button>
                          <button
                            className="emoji-delete-badge"
                            onClick={(e) => removeFromLibrary(em, e)}
                            title="Remove from saved library"
                            aria-label={`Remove icon from library`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="emoji-empty-state">
                      No custom icons saved yet.<br />
                      Paste an emoji or upload an image in the &ldquo;Upload / Link&rdquo; tab to save icons here.
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="emoji-category-header">{currentCategoryData.name} ({currentCategoryData.emojis.length})</div>
                  <div className="emoji-grid" role="listbox">
                    {currentCategoryData.emojis.map((em, idx) => (
                      <button 
                        key={idx} 
                        className={`emoji-btn ${emoji === em ? 'is-active' : ''}`}
                        role="option"
                        aria-selected={emoji === em}
                        onClick={() => { updatePage({ emoji: em }); setShowEmojiPicker(false); }}
                      >
                        <PageIcon icon={em} size={20} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', borderTop: '1px solid var(--border-color)', paddingTop: '6px' }}>
              <button className="emoji-picker-action" onClick={() => { updatePage({ emoji: '' }); setShowEmojiPicker(false); }}>Remove Icon</button>
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



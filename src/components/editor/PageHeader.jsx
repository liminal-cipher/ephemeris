import React, { useState, useRef, useEffect } from 'react'
import { Image as ImageIcon, Smile } from 'lucide-react'
import { updateWorkspacePage } from '../../store/workspace'

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
  const [inputValue, setInputValue] = useState('')
  const emojiInputRef = useRef(null)

  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

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

  // Focus input when popover opens
  useEffect(() => {
    if (showEmojiPicker) {
      setInputValue('')
      const timer = setTimeout(() => {
        emojiInputRef.current?.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [showEmojiPicker])

  // Handle native emoji entry
  const handleInputChange = (e) => {
    const val = e.target.value
    setInputValue(val)
    const detected = extractFirstEmoji(val)
    if (detected) {
      updatePage({ emoji: detected })
      setShowEmojiPicker(false)
    }
  }

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
          <div className="emoji-picker-popover native-emoji-popover" role="dialog" aria-label="Device Emoji Picker">
            <div className="native-emoji-header">
              <span className="native-emoji-title">Select Emoji</span>
            </div>
            
            <div className="native-emoji-input-wrapper">
              <input
                ref={emojiInputRef}
                type="text"
                className="native-emoji-input"
                placeholder="Paste or type native emoji..."
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowEmojiPicker(false)
                  }
                }}
                aria-label="Native emoji input"
              />
            </div>

            <div className="native-emoji-instructions">
              {isMac ? (
                <span>Press <kbd>Cmd</kbd> + <kbd>Ctrl</kbd> + <kbd>Space</kbd> to open native emoji palette</span>
              ) : (
                <span>Press <kbd>Win</kbd> + <kbd>.</kbd> to open native emoji palette</span>
              )}
            </div>

            <div className="native-emoji-actions">
              {emoji && (
                <button className="emoji-picker-action" onClick={() => { updatePage({ emoji: '' }); setShowEmojiPicker(false); }}>Remove Icon</button>
              )}
              <button className="emoji-picker-action" onClick={() => setShowEmojiPicker(false)}>Cancel</button>
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



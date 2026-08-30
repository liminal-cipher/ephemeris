import React, { useState, useEffect } from 'react'
import { useDialogStore } from '../../store/dialogStore'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import './GlobalDialogHost.css'

export default function GlobalDialogHost() {
  const { confirmState, closeConfirm, toasts, removeToast } = useDialogStore()
  const [neverAskChecked, setNeverAskChecked] = useState(false)

  // Reset checkbox when modal opens
  useEffect(() => {
    if (confirmState) {
      setNeverAskChecked(false)
    }
  }, [confirmState])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && confirmState) {
        confirmState.onCancel && confirmState.onCancel()
        closeConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [confirmState, closeConfirm])

  const handleConfirm = () => {
    if (confirmState) {
      if (neverAskChecked && confirmState.showNeverAskKey) {
        try {
          localStorage.setItem(confirmState.showNeverAskKey, 'true')
        } catch (err) {
          console.error('Failed to save never ask preference:', err)
        }
      }
      confirmState.onConfirm && confirmState.onConfirm()
      closeConfirm()
    }
  }

  const handleCancel = () => {
    if (confirmState) {
      confirmState.onCancel && confirmState.onCancel()
      closeConfirm()
    }
  }

  return (
    <>
      {/* Custom Confirmation Modal */}
      {confirmState && (
        <div className="custom-modal-overlay" onClick={handleCancel} role="dialog" aria-modal="true">
          <div 
            className="custom-modal-card" 
            onClick={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="custom-modal-header">
              <h3 className="custom-modal-title">{confirmState.title}</h3>
              <button 
                className="custom-modal-close-btn" 
                onClick={handleCancel}
                aria-label="Close dialog"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="custom-modal-body">
              <p>{confirmState.message}</p>
            </div>

            {confirmState.showNeverAskKey && (
              <label className="custom-modal-never-ask">
                <input 
                  type="checkbox" 
                  checked={neverAskChecked}
                  onChange={(e) => setNeverAskChecked(e.target.checked)}
                />
                <span>Never ask again</span>
              </label>
            )}

            <div className="custom-modal-actions">
              <button 
                type="button"
                className="custom-modal-btn cancel-btn" 
                onClick={handleCancel}
              >
                {confirmState.cancelText}
              </button>
              <button 
                type="button"
                className={`custom-modal-btn confirm-btn ${confirmState.isDanger ? 'is-danger' : ''}`}
                onClick={handleConfirm}
                autoFocus
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Toast Notifications */}
      {toasts.length > 0 && (
        <div className="custom-toast-container" role="region" aria-label="Notifications">
          {toasts.map(toast => (
            <div key={toast.id} className={`custom-toast ${toast.type}`} role="status">
              <span className="custom-toast-icon" aria-hidden="true">
                {toast.type === 'success' && <CheckCircle2 size={16} />}
                {toast.type === 'error' && <AlertCircle size={16} />}
                {toast.type === 'info' && <Info size={16} />}
              </span>
              <span className="custom-toast-message">{toast.message}</span>
              <button 
                className="custom-toast-dismiss" 
                onClick={() => removeToast(toast.id)}
                aria-label="Dismiss notification"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

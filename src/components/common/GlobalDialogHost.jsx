import { useState, useEffect, useRef, useId } from 'react'
import { useDialogStore } from '../../store/dialogStore'
import { useModalFocus } from './useModalFocus'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import './GlobalDialogHost.css'

export default function GlobalDialogHost() {
  const { confirmState, closeConfirm, toasts, removeToast } = useDialogStore()
  const [neverAskChecked, setNeverAskChecked] = useState(false)
  const [pending, setPending] = useState(false), [error, setError] = useState('')
  const dialog = useRef(null), submitting = useRef(false), titleId = useId(), messageId = useId()
  useModalFocus(dialog, Boolean(confirmState), '.cancel-btn')

  // Reset checkbox when modal opens
  useEffect(() => {
    if (confirmState) {
      setNeverAskChecked(false)
      setError('')
    }
  }, [confirmState])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !e.isComposing && confirmState && !submitting.current) {
        e.preventDefault()
        confirmState.onCancel?.()
        closeConfirm()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [confirmState, closeConfirm])

  const handleConfirm = async () => {
    if (confirmState && !submitting.current) {
      submitting.current = true; setPending(true); setError('')
      try {
        await confirmState.onConfirm?.()
        if (neverAskChecked && confirmState.showNeverAskKey) {
          try {
            localStorage.setItem(confirmState.showNeverAskKey, 'true')
          } catch (err) {
            console.error('Failed to save never ask preference:', err)
          }
        }
        closeConfirm()
      } catch (failure) { setError(failure.message || 'The action could not be completed. Please retry.') }
      finally { submitting.current = false; setPending(false) }
    }
  }

  const handleCancel = () => {
    if (confirmState && !submitting.current) {
      confirmState.onCancel?.()
      closeConfirm()
    }
  }

  return (
    <>
      {/* Custom Confirmation Modal */}
      {confirmState && (
        <div ref={dialog} className="custom-modal-overlay" onClick={handleCancel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} tabIndex={-1}>
          <div 
            className="custom-modal-card" 
            onClick={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="custom-modal-header">
              <h3 id={titleId} className="custom-modal-title">{confirmState.title}</h3>
              <button 
                className="custom-modal-close-btn" 
                onClick={handleCancel}
                aria-label="Close dialog"
                disabled={pending}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <div className="custom-modal-body">
              <p id={messageId}>{confirmState.message}</p>
              {error && <p role="alert">{error}</p>}
              {pending && <p role="status">Working…</p>}
            </div>

            {confirmState.showNeverAskKey && (
              <label className="custom-modal-never-ask">
                <input 
                  type="checkbox" 
                  checked={neverAskChecked}
                  disabled={pending}
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
                disabled={pending}
              >
                {confirmState.cancelText}
              </button>
              <button 
                type="button"
                className={`custom-modal-btn confirm-btn ${confirmState.isDanger ? 'is-danger' : ''}`}
                onClick={handleConfirm}
                disabled={pending}
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

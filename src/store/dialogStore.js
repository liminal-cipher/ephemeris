import { create } from 'zustand'

export const useDialogStore = create((set, get) => ({
  // Confirm Modal state
  confirmState: null, // { title, message, confirmText, cancelText, isDanger, showNeverAskKey, onConfirm, onCancel }

  // Toast state
  toasts: [], // Array of { id, message, type: 'info' | 'success' | 'error' }

  openConfirm: (options) => {
    const { showNeverAskKey, onConfirm } = options
    if (showNeverAskKey) {
      try {
        const skipped = localStorage.getItem(showNeverAskKey) === 'true'
        if (skipped) {
          onConfirm && onConfirm()
          return
        }
      } catch (err) {
        console.error('Failed reading localStorage:', err)
      }
    }

    set({
      confirmState: {
        title: options.title || 'Confirm Action',
        message: options.message || 'Are you sure you want to proceed?',
        confirmText: options.confirmText || 'Confirm',
        cancelText: options.cancelText || 'Cancel',
        isDanger: options.isDanger ?? false,
        showNeverAskKey: options.showNeverAskKey || null,
        onConfirm: options.onConfirm || (() => {}),
        onCancel: options.onCancel || (() => {})
      }
    })
  },

  closeConfirm: () => {
    set({ confirmState: null })
  },

  addToast: (message, type = 'info', duration = 3000) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 7)
    set(state => ({
      toasts: [...state.toasts, { id, message, type }]
    }))

    if (duration > 0) {
      setTimeout(() => {
        get().removeToast(id)
      }, duration)
    }
  },

  removeToast: (id) => {
    set(state => ({
      toasts: state.toasts.filter(t => t.id !== id)
    }))
  }
}))

export const showToast = (message, type = 'info', duration = 3000) => {
  useDialogStore.getState().addToast(message, type, duration)
}

export const showConfirm = (options) => {
  useDialogStore.getState().openConfirm(options)
}

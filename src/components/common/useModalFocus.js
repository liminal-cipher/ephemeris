import { useEffect } from 'react'

// Keep keyboard and assistive-technology navigation inside the active modal,
// then return focus to its caller. Preserve any pre-existing inert boundaries.
export function useModalFocus(ref, open, initialSelector = 'input,button') {
  useEffect(() => {
    const modal = ref.current
    if (!open || !modal) return
    const previous = document.activeElement
    const siblings = []
    for (let node = modal; node?.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node) { siblings.push([sibling, sibling.hasAttribute('inert')]); sibling.setAttribute('inert', '') }
      }
    }
    const focusInitial = () => (modal.querySelector(initialSelector) || modal).focus()
    focusInitial()
    const onFocus = event => { if (!modal.contains(event.target)) focusInitial() }
    const onKey = event => {
      if (event.key !== 'Tab' || event.isComposing) return
      const controls = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length)
      const first = controls[0], last = controls.at(-1)
      if (!first) { event.preventDefault(); modal.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('focusin', onFocus)
    modal.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('focusin', onFocus)
      modal.removeEventListener('keydown', onKey)
      siblings.forEach(([element, inert]) => { if (!inert) element.removeAttribute('inert') })
      if (previous?.isConnected) previous.focus()
    }
  }, [ref, open, initialSelector])
}

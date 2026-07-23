import { create } from 'zustand'

export const useStore = create((set) => ({
  activePageId: null,
  setActivePageId: (id) => set({ activePageId: id })
}))

import { create } from 'zustand'

export const useNavigationStore = create((set) => ({
  activePageId: null,
  setActivePageId: (id) => set({ activePageId: id })
}))

import { create } from 'zustand';

/** View-only UI state that the controller does not need to know about. */
export type BottomTab = 'segments' | 'checkpoints' | 'export';

interface UiState {
  bottomTab: BottomTab;
  /** Files are being dragged over the window. */
  dragOver: boolean;
  setBottomTab(tab: BottomTab): void;
  setDragOver(on: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  bottomTab: 'segments',
  dragOver: false,
  setBottomTab: (bottomTab) => set({ bottomTab }),
  setDragOver: (dragOver) => set({ dragOver }),
}));

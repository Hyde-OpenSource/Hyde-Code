import { useSyncExternalStore } from 'react';
import type { AccentColorName } from '@/design/tokens';
import type { StatusKind } from '@/components/PixelBadge';
import type { ThemeId } from '@/scene/office/themeRegistry';
import type { OfficeCharacterName } from '@/scene/office/cast';

// The ported office reads a zustand-style store (useStore(selector), getState(),
// subscribe((s, prev) => …)). This is that API in a few lines, filled from the Hyde hub
// by bridge.ts instead of from Munder Difflin's Electron process.

export interface Agent {
  id: string;
  name: string;
  status: StatusKind;
  /** What it is doing right now (last tool call). */
  action?: string;
  /** The task it is on, shown when there is no live action. */
  lastPrompt?: string;
  /** Tool name for the thought-bubble icon. */
  carrying?: string;
  isGod?: boolean;
  character: OfficeCharacterName;
  accent: AccentColorName;
}

export type CommandCenterTab = 'tasks' | 'human' | 'activity' | 'triggers';

export interface State {
  agents: Agent[];
  selectedId: string | null;
  officeTheme: ThemeId;
  fullscreenAgentId: string | null;
  ideOpen: boolean;
  commandCenterTab: CommandCenterTab;
  /** The owner's LimeZu tiles are loaded (their licence requires a visible credit). */
  tilesLicensed: boolean;
  select: (id: string | null) => void;
  requestCommandCenterTab: (tab: CommandCenterTab | string) => void;
}

type Listener = (state: State, prev: State) => void;

function create(init: (set: (patch: Partial<State>) => void) => State) {
  let state: State;
  const listeners = new Set<Listener>();
  const set = (patch: Partial<State>) => {
    const prev = state;
    state = { ...state, ...patch };
    for (const l of listeners) l(state, prev);
  };
  state = init(set);
  const subscribe = (l: Listener) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  function useStore<T>(selector: (s: State) => T): T {
    return useSyncExternalStore(
      (cb) => subscribe(() => cb()),
      () => selector(state),
    );
  }
  return Object.assign(useStore, { getState: () => state, setState: set, subscribe });
}

export const useStore = create((set) => ({
  agents: [],
  selectedId: null,
  officeTheme: 'office',
  fullscreenAgentId: null,
  ideOpen: false,
  commandCenterTab: 'tasks',
  tilesLicensed: false,
  select: (id) => set({ selectedId: id }),
  requestCommandCenterTab: (tab) => {
    const map: Record<string, CommandCenterTab> = { tasks: 'tasks', human: 'human', triggers: 'activity', activity: 'activity' };
    set({ commandCenterTab: map[tab] ?? 'tasks', selectedId: null });
  },
}));

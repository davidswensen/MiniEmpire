// Network messages between the browser and the relay server (JSON over WebSocket).

import type { Command, GameMode, GameSetup, PlayerCommand } from './types.ts';

export interface TurnMsg {
  t: number; // turn number, starting at 0
  c: PlayerCommand[]; // in the exact order every client must apply them
}

export type SlotKind = 'open' | 'human' | 'bot';

export interface LobbySlot {
  kind: SlotKind;
  name: string;
  team: number;
  ready: boolean;
  botLevel: number;
  hat: number;
  connected: boolean;
}

export interface RoomInfo {
  code: string;
  mode: GameMode;
  host: number; // slot index of host
  slots: LobbySlot[];
  isPublic: boolean;
  started: boolean;
}

export type ClientMsg =
  | { type: 'hello'; name: string; hat: number; token?: string }
  | { type: 'create'; mode: GameMode; isPublic: boolean }
  | { type: 'join'; code: string }
  | { type: 'quick' }
  | { type: 'leave' }
  | { type: 'ready'; ready: boolean }
  | { type: 'setBot'; slot: number; botLevel: number } // botLevel < 0 removes the bot
  | { type: 'start' }
  | { type: 'cmd'; c: Command }
  | { type: 'hash'; t: number; h: number }
  | { type: 'chat'; i: number; emote?: boolean }
  | { type: 'ping'; at: number };

export type ServerMsg =
  | { type: 'welcome'; token: string; rejoin?: boolean }
  | { type: 'room'; room: RoomInfo; you: number }
  | { type: 'left' }
  | { type: 'error'; msg: string }
  | { type: 'start'; setup: GameSetup; you: number; code: string }
  | { type: 'turn'; turn: TurnMsg }
  | { type: 'history'; setup: GameSetup; you: number; code: string; turns: TurnMsg[] }
  | { type: 'chat'; p: number; i: number; emote?: boolean }
  | { type: 'desync'; t: number }
  | { type: 'presence'; slot: number; connected: boolean }
  | { type: 'pong'; at: number };

export const MODE_SLOTS: Record<GameMode, number[]> = {
  '1v1': [0, 1],
  '2v2': [0, 0, 1, 1],
  ffa3: [0, 1, 2],
  ffa4: [0, 1, 2, 3],
};

export const MODE_NAMES: Record<GameMode, string> = {
  '1v1': '1 vs 1',
  '2v2': '2 vs 2',
  ffa3: '3-player free-for-all',
  ffa4: '4-player free-for-all',
};

/** Validate a room code typed by a player. */
export function cleanCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

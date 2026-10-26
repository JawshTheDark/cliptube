import { useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import type { VideoPlayer } from 'expo-video';

/**
 * One video plays at a time. Screens stay mounted under the ones opened on top of them (so Back returns to them),
 * and their players would keep playing. When a screen with a player comes to the top (opened, or returned to with
 * Back), every other player pauses; a player that was paused that way picks up again when its own screen is back on
 * top. Screens without a player (comments, Save, a channel page) don't pause anything, so a video keeps playing under
 * them.
 */
const players = new Map<symbol, VideoPlayer>();
const heldBack = new Set<symbol>(); // paused because another video opened

function pauseOthers(key: symbol) {
  for (const [k, p] of players) {
    if (k === key) continue;
    try {
      if (p.playing) {
        p.pause();
        heldBack.add(k);
      }
    } catch {
      /* a player being released */
    }
  }
}

/**
 * For a screen's player. `pausable: false` is for a player that something else keeps in step (a watch party follows
 * the party's clock): it still pauses other videos when it opens, but nothing pauses it.
 */
export function useOnePlayerAtATime(player: VideoPlayer, { pausable = true }: { pausable?: boolean } = {}) {
  const focused = useIsFocused();
  const key = useRef(Symbol('player')).current;
  useEffect(() => {
    if (!pausable) return;
    players.set(key, player);
    return () => {
      players.delete(key);
      heldBack.delete(key);
    };
  }, [key, player, pausable]);
  useEffect(() => {
    if (!focused) return;
    pauseOthers(key);
    if (heldBack.delete(key)) {
      try {
        player.play();
      } catch {
        /* released */
      }
    }
  }, [focused, key, player]);
}

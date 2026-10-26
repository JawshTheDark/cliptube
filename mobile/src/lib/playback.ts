import { useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import type { VideoPlayer } from 'expo-video';

/**
 * One video plays at a time. Screens stay mounted under the ones opened on top of them (so Back returns to them),
 * and their players would keep playing. When a screen with a player comes to the top (opened, or returned to with
 * Back), every other player pauses; a player that was paused that way picks up again when its own screen is back on
 * top. Screens without a player (comments, Save, a channel page) don't pause anything, so a video keeps playing under
 * them.
 *
 * The player that came to the top last is also the current one: timestamps in comments seek it, and the comment
 * box's Add time reads its time.
 */
const players = new Map<symbol, VideoPlayer>();
const heldBack = new Set<symbol>(); // paused because another video opened
let current: { key: symbol; player: VideoPlayer } | null = null;

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
 * the party's clock): it still pauses other videos when it opens, but nothing pauses it. `active: false` is for a
 * player kept loaded but not the one on screen (the Shorts on either side of the visible one).
 */
export function useOnePlayerAtATime(player: VideoPlayer, { pausable = true, active = true }: { pausable?: boolean; active?: boolean } = {}) {
  const focused = useIsFocused();
  const key = useRef(Symbol('player')).current;
  useEffect(() => {
    if (!pausable || !active) return;
    players.set(key, player);
    return () => {
      players.delete(key);
      heldBack.delete(key);
    };
  }, [key, player, pausable, active]);
  useEffect(() => {
    if (!focused || !active) return;
    current = { key, player };
    pauseOthers(key);
    if (heldBack.delete(key)) {
      try {
        player.play();
      } catch {
        /* released */
      }
    }
  }, [focused, active, key, player]);
  useEffect(
    () => () => {
      if (current?.key === key) current = null;
    },
    [key],
  );
}

/** Seconds into the current video, or null when nothing is loaded. */
export function currentTime(): number | null {
  try {
    return current ? current.player.currentTime : null;
  } catch {
    return null;
  }
}

/** Jumps the current video to `seconds` and plays it. False when there is no video to seek. */
export function seekCurrent(seconds: number): boolean {
  if (!current) return false;
  try {
    current.player.currentTime = seconds;
    current.player.play();
    return true;
  } catch {
    return false;
  }
}

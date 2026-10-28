import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { colors } from '@/lib/theme';

/**
 * A seek bar: drag or tap anywhere on it. `onSeek` gets the time under the finger while dragging; `onStart` runs
 * when a drag begins (to pause), `onEnd` when it's let go.
 */
export function Scrubber({ value, max, onSeek, onStart, onEnd, disabled }: { value: number; max: number; onSeek: (t: number) => void; onStart?: () => void; onEnd?: () => void; disabled?: boolean }) {
  const width = useRef(1);
  const [dragging, setDragging] = useState(false);
  // The handlers are made once, so they read the latest props through a ref.
  const props = useRef({ max, onSeek, onStart, onEnd, disabled });
  props.current = { max, onSeek, onStart, onEnd, disabled };
  const at = (x: number) => Math.max(0, Math.min(props.current.max, (x / width.current) * props.current.max));
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !props.current.disabled,
      onMoveShouldSetPanResponder: () => !props.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        setDragging(true);
        props.current.onStart?.();
        props.current.onSeek(at(e.nativeEvent.locationX));
      },
      onPanResponderMove: (e) => props.current.onSeek(at(e.nativeEvent.locationX)),
      onPanResponderRelease: () => {
        setDragging(false);
        props.current.onEnd?.();
      },
      onPanResponderTerminate: () => {
        setDragging(false);
        props.current.onEnd?.();
      },
    }),
  ).current;
  const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <View
      style={[s.hit, disabled && { opacity: 0.4 }]}
      onLayout={(e: LayoutChangeEvent) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
      accessibilityRole="adjustable"
      accessibilityValue={{ min: 0, max: Math.round(max), now: Math.round(value) }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={s.track}>
        <View style={[s.fill, { width: `${share * 100}%` }]} />
      </View>
      <View pointerEvents="none" style={[s.knob, dragging && s.knobOn, { left: `${share * 100}%` }]} />
    </View>
  );
}

const s = StyleSheet.create({
  hit: { height: 36, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
  knob: { position: 'absolute', width: 16, height: 16, borderRadius: 8, marginLeft: -8, backgroundColor: colors.accent, top: 10 },
  knobOn: { transform: [{ scale: 1.3 }] },
});

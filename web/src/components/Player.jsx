import { useEffect } from 'react';

/**
 * Native <video> with YouTube-style keyboard shortcuts, resume position and progress reporting.
 * `videoRef` is owned by the parent so the description timestamps and share dialog can reach the element.
 */
export function Player({ video, videoRef, startAt = 0, onProgress, theater, onToggleTheater }) {
  // Seek to the start position once metadata is known.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const seek = () => {
      if (startAt > 3 && startAt < (el.duration || video.duration) - 5) el.currentTime = startAt;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
    return () => el.removeEventListener('loadedmetadata', seek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // Report playback position (throttled) for watch history / resume.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !onProgress) return;
    let last = -10;
    const tick = () => {
      if (Math.abs(el.currentTime - last) >= 5) {
        last = el.currentTime;
        onProgress(el.currentTime);
      }
    };
    const flush = () => {
      last = el.currentTime;
      onProgress(el.currentTime);
    };
    el.addEventListener('timeupdate', tick);
    el.addEventListener('pause', flush);
    el.addEventListener('ended', flush);
    return () => {
      el.removeEventListener('timeupdate', tick);
      el.removeEventListener('pause', flush);
      el.removeEventListener('ended', flush);
    };
  }, [video.id, onProgress, videoRef]);

  // Keyboard shortcuts.
  useEffect(() => {
    const h = (e) => {
      const el = videoRef.current;
      if (!el || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const nativeFocused = e.target === el;
      const key = e.key;
      if (nativeFocused && (key === ' ' || key.startsWith('Arrow'))) return; // browser handles these already
      switch (key) {
        case ' ':
        case 'k':
          e.preventDefault();
          if (el.paused) el.play();
          else el.pause();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          el.currentTime = Math.max(0, el.currentTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 5);
          break;
        case 'j':
          el.currentTime = Math.max(0, el.currentTime - 10);
          break;
        case 'l':
          el.currentTime = Math.min(el.duration || Infinity, el.currentTime + 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          el.volume = Math.min(1, el.volume + 0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          el.volume = Math.max(0, el.volume - 0.1);
          break;
        case 'm':
          el.muted = !el.muted;
          break;
        case 'f':
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen?.();
          break;
        case 't':
          onToggleTheater?.();
          break;
        case ',':
          if (el.paused) el.currentTime = Math.max(0, el.currentTime - 1 / 30);
          break;
        case '.':
          if (el.paused) el.currentTime = el.currentTime + 1 / 30;
          break;
        default:
          if (/^[0-9]$/.test(key) && el.duration) el.currentTime = (el.duration * Number(key)) / 10;
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [videoRef, onToggleTheater]);

  return (
    <div className={`player ${theater ? 'theater' : ''}`}>
      <video
        key={video.id}
        ref={videoRef}
        src={video.video_url}
        poster={video.thumbnail_url || undefined}
        controls
        autoPlay
        playsInline
        controlsList="nodownload"
      />
    </div>
  );
}

import { useEffect, useLayoutEffect, useState } from 'react';

export function usePresence<Value>(value: Value | null, duration = 90) {
  const [retained, setRetained] = useState(value);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    if (value !== null) { setRetained(value); return; }
    if (reduced) { setRetained(null); return; }
    const timer = setTimeout(() => setRetained(null), duration);
    return () => clearTimeout(timer);
  }, [value, duration, reduced]);
  return { value: value ?? (reduced ? null : retained), closing: value === null };
}

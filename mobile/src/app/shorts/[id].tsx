import { useLocalSearchParams } from 'expo-router';
import { ShortsScreen } from '@/components/Shorts';

/** A Short on this server, then the newest after it: /shorts/<id>, like the website. */
export default function ShortRoute() {
  const p = useLocalSearchParams<{ id: string; server?: string; scope?: string }>();
  return <ShortsScreen id={p.id} server={p.server} scope={p.scope} />;
}

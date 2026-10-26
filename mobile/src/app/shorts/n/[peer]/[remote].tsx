import { useLocalSearchParams } from 'expo-router';
import { ShortsScreen } from '@/components/Shorts';

/** A Short from another server in the network: /shorts/n/<peer>/<remote id>, like the website. */
export default function NetworkShortRoute() {
  const p = useLocalSearchParams<{ peer: string; remote: string; server?: string; scope?: string }>();
  return <ShortsScreen peer={p.peer} remote={p.remote} server={p.server} scope={p.scope} />;
}

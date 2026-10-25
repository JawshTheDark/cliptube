import { useLocalSearchParams } from 'expo-router';
import { WatchScreen } from '@/components/Watch';

/** A clip hosted on another server in the network: it streams from there, interactions go through here. */
export default function NetworkWatch() {
  const { peer, remote, server } = useLocalSearchParams<{ peer: string; remote: string; server?: string }>();
  return <WatchScreen key={`${server || ''}|${peer}|${remote}`} peer={peer} remote={remote} server={server} />;
}

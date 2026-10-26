import { useLocalSearchParams } from 'expo-router';
import { WatchScreen } from '@/components/Watch';

/** A video hosted on another server in the network: it streams from there, interactions go through here. */
export default function NetworkWatch() {
  const { peer, remote, server, list, shuffle } = useLocalSearchParams<{ peer: string; remote: string; server?: string; list?: string; shuffle?: string }>();
  return <WatchScreen key={`${server || ''}|${peer}|${remote}|${list || ''}`} peer={peer} remote={remote} server={server} list={list} shuffle={shuffle} />;
}

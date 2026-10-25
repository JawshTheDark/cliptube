import { useLocalSearchParams } from 'expo-router';
import { WatchScreen } from '@/components/Watch';

export default function Watch() {
  const { id, server, list, shuffle } = useLocalSearchParams<{ id: string; server?: string; list?: string; shuffle?: string }>();
  return <WatchScreen key={`${server || ''}|${id}|${list || ''}`} id={id} server={server} list={list} shuffle={shuffle} />;
}

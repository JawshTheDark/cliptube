import { useLocalSearchParams } from 'expo-router';
import { WatchScreen } from '@/components/Watch';

export default function Watch() {
  const { id, server } = useLocalSearchParams<{ id: string; server?: string }>();
  return <WatchScreen key={`${server || ''}|${id}`} id={id} server={server} />;
}

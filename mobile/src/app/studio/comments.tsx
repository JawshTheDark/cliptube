import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { s as fs } from '@/components/Form';
import { HeldComments } from '@/components/HeldComments';
import { Text } from '@/components/Text';
import { readable } from '@/lib/layout';
import { colors } from '@/lib/theme';

/** Comments held for review on your own videos (the website's Studio → Comments to review). */
export default function StudioComments() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 12, gap: 12, paddingBottom: 32 }, readable]}>
      <Text style={fs.hint}>
        Comments that spam checks, your blocked words or your review setting held back. Approve them to publish, or delete them. Change what gets held in{' '}
        <Text style={{ color: colors.link }} onPress={() => router.push('/account?tab=channel' as any)}>
          Settings
        </Text>
        .
      </Text>
      <HeldComments endpoint="/me/comments/held" />
    </ScrollView>
  );
}

import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Section, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Loading } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Legal = { site_name?: string; rules?: string; terms?: string; contact_email?: string; dmca_agent?: string; transparency_public?: boolean };

/** Rules and contact, the website's /legal: the server's rules, terms, and abuse and copyright contacts. */
export default function LegalPage() {
  const { api } = useSession();
  const [info, setInfo] = useState<Legal | null>(null);
  useEffect(() => {
    api
      .get<Legal>('/legal')
      .then(setInfo)
      .catch(() => setInfo({}));
  }, [api]);
  if (!info) return <Loading />;
  const nothing = !info.rules && !info.terms && !info.contact_email && !info.dmca_agent;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 12, gap: 14, paddingBottom: 40 }, readable]}>
      {nothing && <Text style={fs.hint}>{`The admins of ${info.site_name || 'this server'} haven't published rules or contact details yet.`}</Text>}
      {!!info.rules && (
        <Section title="Rules">
          <Text style={s.body} selectable>
            {info.rules}
          </Text>
        </Section>
      )}
      {!!info.terms && (
        <Section title="Terms">
          <Text style={s.body} selectable>
            {info.terms}
          </Text>
        </Section>
      )}
      {!!(info.contact_email || info.dmca_agent) && (
        <Section title="Report abuse or copyright infringement">
          <Text style={s.body}>Signed-in people can use Report on any video, comment or channel. Otherwise:</Text>
          {!!info.contact_email && (
            <Text style={s.body}>
              Email{' '}
              <Text style={{ color: colors.link }} onPress={() => Linking.openURL(`mailto:${info.contact_email}`)}>
                {info.contact_email}
              </Text>
            </Text>
          )}
          {!!info.dmca_agent && (
            <View style={{ gap: 4 }}>
              <Text style={fs.label}>DMCA agent</Text>
              <Text style={s.body} selectable>
                {info.dmca_agent}
              </Text>
            </View>
          )}
          <Text style={fs.hint}>
            A copyright notice should identify the work, the video's link, your contact details, and a statement that you believe the use isn't authorised. If your video was removed and you think it was a mistake, open it while signed in to send a counter-notice.
          </Text>
        </Section>
      )}
      {!!info.transparency_public && (
        <Text style={{ color: colors.link }} onPress={() => router.push('/transparency' as any)}>
          Transparency report
        </Text>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
});

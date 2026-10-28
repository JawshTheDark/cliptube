import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Notice, Section } from '@/components/Form';
import { Text } from '@/components/Text';
import { hostOf } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const Steps = ({ items }: { items: React.ReactNode[] }) => (
  <View style={{ gap: 8 }}>
    {items.map((it, i) => (
      <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
        <Text style={s.num}>{i + 1}.</Text>
        <Text style={[s.body, { flex: 1 }]}>{it}</Text>
      </View>
    ))}
  </View>
);
const Code = ({ children }: { children: string }) => (
  <Text style={s.code} selectable>
    {children}
  </Text>
);
const Link = ({ to, children }: { to: string; children: string }) => (
  <Text style={{ color: colors.link }} onPress={() => router.push(to as any)}>
    {children}
  </Text>
);

/** Following from the fediverse, the website's /help/fediverse: Mastodon, PeerTube, and moving a channel. */
export default function HelpFediverse() {
  const { site, user, server } = useSession();
  const host = site?.ap_host || hostOf(server);
  const name = user?.username || 'name';
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 12, gap: 14, paddingBottom: 40 }, readable]}>
      {(site as any)?.activitypub === false && <Notice tone="warn">This site has ActivityPub turned off right now, so the steps below won’t work here.</Notice>}
      <Text style={s.body}>
        {`${site?.site_name || host} speaks ActivityPub, the language Mastodon, PeerTube and the rest of the fediverse use. People there can follow channels here without an account, and people here can follow channels there.`}
      </Text>
      <Section title="From Mastodon (and GoToSocial, Misskey, Pleroma…)">
        <Steps
          items={[
            <>
              Search for the account, like <Code>{`@${name}@${host}`}</Code>, and press Follow.
            </>,
            'New clips show up in your home timeline with the title and a playable video.',
            'Replies become comments under the video here, favourites count as likes, and boosts count as shares.',
          ]}
        />
      </Section>
      <Section title="From PeerTube">
        <Steps
          items={[
            <>
              Search for the channel, like <Code>{`@${name}_channel@${host}`}</Code>, or paste the channel’s link into PeerTube’s search.
            </>,
            'PeerTube plays the videos from here; comments and likes come back the same way.',
            <>
              PeerTube admins can follow this whole site: follow <Code>{`@${host}@${host}`}</Code> from the instance follows page.
            </>,
          ]}
        />
      </Section>
      <Section title="Following fediverse channels from here">
        <Text style={s.body}>
          Open <Link to="/library/subscriptions">Subscriptions</Link> and use <Text style={s.b}>Follow from the fediverse</Text> with a handle or a link. Their new videos join your subscriptions, and you can like and
          comment on them here.
        </Text>
      </Section>
      <Section title="Moving a channel to another site">
        <Steps
          items={[
            <>
              On the old site: <Link to="/account?tab=account">Settings → Account</Link> → <Text style={s.b}>Export channel</Text>, then copy its private link.
            </>,
            <>
              On the new site: paste the link under <Text style={s.b}>Import a channel here</Text>. Videos, comments, captions and the profile come along.
            </>,
            <>
              On the new site: add the old account under <Text style={s.b}>Moving here</Text>.
            </>,
            <>
              On the old site: enter the new account under <Text style={s.b}>Moving away</Text>. Subscribers here, on other OurTube servers and on Mastodon or PeerTube are moved to the new channel, and the old channel points there.
            </>,
          ]}
        />
      </Section>
      <Section title="What stays here">
        <Text style={s.body}>Private and unlisted videos, and videos with “share with the network” turned off, are never sent to other servers.</Text>
      </Section>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  body: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
  b: { fontWeight: '700' },
  num: { color: colors.text2, fontWeight: '700', width: 18 },
  code: { fontFamily: 'monospace', fontSize: 13, color: colors.text, backgroundColor: colors.surface2 },
});

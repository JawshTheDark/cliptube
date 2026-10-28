import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { InfoRow, Section, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Loading } from '@/components/ui';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Report = {
  since?: number | null;
  takedown_notices: number;
  videos_removed_for_copyright: number;
  notices_rejected: number;
  counter_notices: number;
  videos_restored: number;
  reports_received: number;
  reports_actioned: number;
  accounts_suspended_or_banned: number;
  notices?: { received_at: number; claimant: string; work: string; video_title: string | null; status: string; action: string }[];
};

const day = (ms: number) => new Date(ms).toLocaleDateString();
const OUTCOME: Record<string, string> = { removed: 'Removed', none: 'No action', rejected: 'Rejected' };

/** The transparency report, the website's /transparency: notices, removals and moderation counts, all time. */
export default function Transparency() {
  const { api } = useSession();
  const [t, setT] = useState<Report | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api
      .get<Report>('/transparency')
      .then(setT)
      .catch(() => setError(true));
  }, [api]);
  if (error) return <Text style={[fs.hint, { padding: 16 }]}>This site doesn't publish a transparency report.</Text>;
  if (!t) return <Loading />;
  const rows: [string, number][] = [
    ['Copyright notices received', t.takedown_notices],
    ['Videos removed after a notice', t.videos_removed_for_copyright],
    ['Notices rejected as invalid', t.notices_rejected],
    ['Counter-notices received', t.counter_notices],
    ['Videos restored after a counter-notice', t.videos_restored],
    ['Reports received', t.reports_received],
    ['Reports acted on', t.reports_actioned],
    ['Accounts suspended or banned', t.accounts_suspended_or_banned],
  ];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={[{ padding: 12, gap: 14, paddingBottom: 40 }, readable]}>
      <Text style={fs.hint}>{`All time${t.since ? `, since ${day(t.since)}` : ''}.`}</Text>
      <Section>
        {rows.map(([label, n]) => (
          <View key={label} style={s.row}>
            <Text style={{ flex: 1, color: colors.text }}>{label}</Text>
            <Text style={s.n}>{n}</Text>
          </View>
        ))}
      </Section>
      {!!t.notices?.length && (
        <Section title="Copyright notices">
          {t.notices.map((n, i) => (
            <View key={i} style={{ gap: 2, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline }}>
              <InfoRow label="Received" value={day(n.received_at)} />
              <InfoRow label="From" value={n.claimant} />
              <InfoRow label="Work" value={n.work} />
              <InfoRow label="Video" value={n.video_title} />
              <InfoRow label="Outcome" value={n.status === 'restored' ? 'Restored after counter-notice' : OUTCOME[n.action] || n.action} />
            </View>
          ))}
        </Section>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  n: { color: colors.text, fontWeight: '700', fontVariant: ['tabular-nums'] },
});

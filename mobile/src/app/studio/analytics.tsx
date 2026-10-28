import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ListItem, Section, Select, Stats, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Button, ErrorBox, Loading } from '@/components/ui';
import { compact, duration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Day = { day: string; views: number; watch_seconds: number };
type Data = {
  video: { id: string; title: string; duration: number | null } | null;
  totals: { views: number; watch_seconds: number };
  daily: Day[];
  retention: { at: number; share: number }[];
  referrers: { source: string; views: number }[];
  top: { id: string; title: string; views: number; watch_seconds: number }[];
};

const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
};

const SOURCE_LABELS: Record<string, string> = {
  direct: 'Direct or app',
  'site:home': 'Home on this site',
  'site:trending': 'Trending',
  'site:search': 'Search',
  'site:channel': 'Your channel',
  'site:watch': 'Other videos (related)',
  'site:subscriptions': 'Subscriptions feed',
  'site:network': 'Network page',
  'site:game': 'Game pages',
  'site:history': 'Watch history',
  'site:liked': 'Liked videos',
  'site:notifications': 'Notifications',
  'site:studio': 'Studio',
  'site:compare': 'Compare',
  'site:other': 'Elsewhere on this site',
};

const RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '28', label: 'Last 28 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];

/**
 * A column chart: one bar per item from a shared baseline, a scale on the left, tap a bar for its value (the
 * website's charts, drawn with views since the app has no SVG).
 */
function Bars({ items, label }: { items: { key: string; value: number; tip: string; sub: string }[]; label: (v: number) => string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...items.map((x) => x.value)));
  const H = 140;
  const shown = picked !== null ? items[picked] : null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={[fs.hint, { minHeight: 17 }]}>{shown ? `${shown.tip} · ${shown.sub}` : 'Tap a bar for its value'}</Text>
      <View style={{ flexDirection: 'row', height: H }}>
        <View style={{ width: 44, justifyContent: 'space-between', alignItems: 'flex-end', paddingRight: 6 }}>
          <Text style={s.tick}>{label(max)}</Text>
          <Text style={s.tick}>{label(max / 2)}</Text>
          <Text style={s.tick}>{label(0)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          {[0, 0.5, 1].map((f) => (
            <View key={f} style={[s.grid, { top: H * f }]} />
          ))}
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: items.length > 60 ? 0 : 1 }}>
            {items.map((x, i) => (
              <Pressable key={x.key} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }} onPress={() => setPicked(picked === i ? null : i)} accessibilityLabel={`${x.sub}: ${x.tip}`}>
                <View style={[s.bar, { height: (H * x.value) / max }, picked === i && { backgroundColor: colors.text }]} />
              </Pressable>
            ))}
          </View>
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 44 }}>
        <Text style={s.tick}>{items[0]?.sub}</Text>
        <Text style={s.tick}>{items[items.length - 1]?.sub}</Text>
      </View>
    </View>
  );
}

/** Channel analytics, or one video's (?video=…): the website's Studio → Analytics. Counts only, nobody identified. */
export default function Analytics() {
  const params = useLocalSearchParams<{ video?: string }>();
  const { api } = useSession();
  const { wide } = useLayout();
  const [days, setDays] = useState('28');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    setData(null);
    api
      .get<Data>(`/studio/analytics?days=${days}${params.video ? `&video=${encodeURIComponent(params.video)}` : ''}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [api, days, params.video]);
  const avg = useMemo(() => (data && data.totals.views ? data.totals.watch_seconds / data.totals.views : 0), [data]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const maxRef = Math.max(1, ...data.referrers.map((r) => r.views));
  const day = (d: string) => d.slice(5);
  const charts = [
    <Section key="views" title="Views per day" style={wide ? s.half : s.full}>
      <Bars items={data.daily.map((d) => ({ key: d.day, value: d.views, tip: `${compact(d.views)} views`, sub: day(d.day) }))} label={compact} />
    </Section>,
    <Section key="time" title="Watch time per day" style={wide ? s.half : s.full}>
      <Bars items={data.daily.map((d) => ({ key: d.day, value: d.watch_seconds, tip: hours(d.watch_seconds), sub: day(d.day) }))} label={hours} />
    </Section>,
  ];
  if (data.video) {
    const len = data.video.duration || 0;
    charts.push(
      <Section key="retention" title="Audience retention" hint="Share of viewers still watching at each point of the video." style={wide ? s.half : s.full}>
        {data.retention.length ? (
          <Bars
            items={data.retention.map((p) => ({ key: String(p.at), value: p.share * 100, tip: `${Math.round(p.share * 100)}% still watching`, sub: duration((len * p.at) / 100) }))}
            label={(v) => `${Math.round(v)}%`}
          />
        ) : (
          <Text style={fs.hint}>Not enough plays yet.</Text>
        )}
      </Section>,
    );
  }
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 12, gap: 14, paddingBottom: 40 }}>
      <Stack.Screen options={{ title: data.video ? data.video.title : 'Channel analytics' }} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <View style={{ minWidth: 170 }}>
          <Select value={days} options={RANGES} onChange={setDays} small />
        </View>
        <Button title={table ? 'Show charts' : 'Show as table'} small kind="ghost" onPress={() => setTable((t) => !t)} />
        {data.video && <Button title="Video" icon="play-arrow" small kind="ghost" onPress={() => router.push(`/watch/${encodeURIComponent(data.video!.id)}`)} />}
      </View>
      <Text style={fs.hint}>Counts only: nothing here identifies who watched. Viewers who aren't signed in are included.</Text>
      <Stats
        items={[
          { n: compact(data.totals.views), l: 'Views' },
          { n: hours(data.totals.watch_seconds), l: 'Watch time' },
          { n: avg ? duration(avg) : '—', l: 'Average view' },
        ]}
      />
      {table ? (
        <Section>
          <View style={s.tr}>
            <Text style={[s.th, { flex: 1 }]}>Day</Text>
            <Text style={[s.th, s.num]}>Views</Text>
            <Text style={[s.th, s.num]}>Watch time</Text>
          </View>
          {[...data.daily].reverse().map((d) => (
            <View key={d.day} style={s.tr}>
              <Text style={[s.td, { flex: 1 }]}>{d.day}</Text>
              <Text style={[s.td, s.num]}>{d.views}</Text>
              <Text style={[s.td, s.num]}>{hours(d.watch_seconds)}</Text>
            </View>
          ))}
        </Section>
      ) : (
        <View style={s.grid2}>{charts}</View>
      )}
      <View style={s.grid2}>
        <Section title="Where views came from" style={wide ? s.half : s.full}>
          {data.referrers.length === 0 ? (
            <Text style={fs.hint}>No views in this period.</Text>
          ) : (
            data.referrers.map((r) => (
              <View key={r.source} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.text, width: 150, fontSize: 13.5 }} numberOfLines={1}>
                  {SOURCE_LABELS[r.source] || r.source}
                </Text>
                <View style={s.refTrack}>
                  <View style={[s.refFill, { width: `${(r.views / maxRef) * 100}%` }]} />
                </View>
                <Text style={[s.td, { width: 44, textAlign: 'right' }]}>{compact(r.views)}</Text>
              </View>
            ))
          )}
        </Section>
        {!data.video && data.top.length > 0 && (
          <Section title="Top videos" style={wide ? s.half : s.full}>
            {data.top.map((v) => (
              <ListItem
                key={v.id}
                title={v.title}
                sub={`${compact(v.views)} views · ${hours(v.watch_seconds)}`}
                onPress={() => router.push({ pathname: '/studio/analytics' as any, params: { video: v.id } })}
              />
            ))}
          </Section>
        )}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  tick: { color: colors.text2, fontSize: 11, fontVariant: ['tabular-nums'] },
  grid: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
  bar: { backgroundColor: colors.accent, borderTopLeftRadius: 3, borderTopRightRadius: 3, minHeight: 0 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  half: { flexBasis: 360, flexGrow: 1 },
  full: { width: '100%' },
  tr: { flexDirection: 'row', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  th: { color: colors.text2, fontSize: 12.5, fontWeight: '700' },
  td: { color: colors.text, fontSize: 13.5, fontVariant: ['tabular-nums'] },
  num: { width: 90, textAlign: 'right' },
  refTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: 'hidden' },
  refFill: { height: 8, borderRadius: 4, backgroundColor: colors.accent },
});

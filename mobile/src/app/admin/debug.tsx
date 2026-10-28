import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { AdminTabs } from '@/components/AdminTabs';
import { InfoRow, Section, Toggle, s as fs } from '@/components/Form';
import { Text } from '@/components/Text';
import { Button, Empty, Loading, toast } from '@/components/ui';
import { ago, bytes } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

const FOLDERS: Record<string, string> = {
  videos: 'Videos',
  originals: 'Kept originals',
  hls: 'Adaptive streaming',
  renditions: 'Lower qualities',
  thumbs: 'Thumbnails',
  avatars: 'Avatars and banners',
  captions: 'Captions',
  editor: 'Editor sources',
  exports: 'Exports',
  live: 'Live recordings',
  uploads: 'Uploads in progress',
  tmp: 'Temporary files',
};
const uptime = (s: number) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

/** Admin → Debugging, the website's /admin/debug: versions, FFmpeg, disk, the queue, the network and recent errors. */
export default function AdminDebug() {
  const { api, user } = useSession();
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/admin/diagnostics').then(setD).catch((e) => toast(e.message)), [api]);
  useEffect(() => {
    load();
  }, [load]);
  if (!user?.is_admin) return <Empty icon="lock" title="Admins only">Debugging is for this server's admins.</Empty>;
  if (!d) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AdminTabs />
        <Loading />
      </View>
    );
  }
  const update = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const u = await api.post<any>('/admin/diagnostics/update', body);
      setD((x: any) => ({ ...x, update: u }));
      if (body.check) toast(u.error ? `Could not check: ${u.error}` : u.available ? `OurTube ${u.latest} is out` : 'This is the newest version');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const { app, update: u, tools, storage, database, jobs, network, live, email, log } = d;
  const lanes = Object.entries(jobs.lanes || {}) as [string, any][];
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView contentContainerStyle={[{ padding: 16, gap: 14, paddingBottom: 40 }, readable]}>
        <Text style={fs.hint}>What to look at, or send to whoever is helping, when something goes wrong. The report has no passwords or keys in it.</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="Copy the whole report" icon="content-copy" small onPress={async () => (await Clipboard.setStringAsync(JSON.stringify(d, null, 2)), toast('Report copied'))} />
          <Button title="Refresh" icon="refresh" small kind="ghost" onPress={load} />
        </View>

        <Section title="Version">
          <InfoRow label="OurTube" value={app.version} />
          <InfoRow label="Newest on GitHub" value={u.latest ? (u.available ? `${u.latest} is out` : `${u.latest} (up to date)`) : 'not checked yet'} />
          <InfoRow label="Last checked" value={u.checked_at ? ago(u.checked_at) : 'never'} />
          {!!u.error && <InfoRow label="Last check failed" value={u.error} />}
          <Toggle label="Check GitHub for new versions" hint="Every 12 hours, and tell admins." value={!!u.enabled} disabled={busy} onChange={(v) => update({ enabled: v })} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button title="Check now" small disabled={busy || !u.enabled} onPress={() => update({ check: true })} />
            {!!u.changes && <Button title="What changed" small kind="ghost" onPress={() => Linking.openURL(u.changes)} />}
            {!!u.repo && <Button title="How to update" small kind="ghost" onPress={() => Linking.openURL(`${u.repo}/blob/main/docs/wiki/Upgrading-and-Backups.md`)} />}
          </View>
        </Section>

        <Section title="Server">
          <InfoRow label="Running for" value={uptime(app.uptime_seconds)} />
          <InfoRow label="Node.js" value={app.node} />
          <InfoRow label="System" value={`${app.platform}${app.in_docker ? ', in Docker' : ''}`} />
          <InfoRow label="CPU cores" value={app.cpus} />
          <InfoRow label="Memory used by OurTube" value={bytes(app.memory?.rss)} />
          <InfoRow label="Memory free on the machine" value={`${bytes(app.memory?.system_free)} of ${bytes(app.memory?.system_total)}`} />
          <InfoRow label="Public URL" value={app.public_url || 'not set'} />
          <InfoRow label="Address this app used" value={app.address_seen} />
        </Section>

        <Section title="FFmpeg">
          <InfoRow label="ffmpeg" value={tools.ffmpeg?.version} />
          <Text style={fs.hint} numberOfLines={1}>
            {tools.ffmpeg?.path}
          </Text>
          <InfoRow label="ffprobe" value={tools.ffprobe?.version} />
          <Text style={fs.hint} numberOfLines={1}>
            {tools.ffprobe?.path}
          </Text>
          <InfoRow label="Encoder in use" value={tools.encoder} />
          <InfoRow label="GPU encoders in this build" value={tools.hardware_encoders_built_in?.length ? tools.hardware_encoders_built_in.join(', ') : 'none'} />
          <Text style={fs.hint}>Built in doesn't mean the GPU is there: a GPU encoder that fails falls back to the CPU and logs why below.</Text>
        </Section>

        <Section title="Storage">
          {!!storage.disk && <InfoRow label="Free on the data disk" value={`${bytes(storage.disk.free)} of ${bytes(storage.disk.total)}`} />}
          <InfoRow label="Database" value={bytes(storage.database_bytes)} />
          <InfoRow label="Database backups" value={`${bytes(storage.backups?.bytes)} (${storage.backups?.files})`} />
          {Object.entries(FOLDERS).map(([k, label]) => (storage.folders?.[k]?.bytes > 0 ? <InfoRow key={k} label={label} value={bytes(storage.folders[k].bytes)} /> : null))}
          <Text style={fs.hint} numberOfLines={2}>{`Data folder: ${storage.data_dir}`}</Text>
        </Section>

        <Section title="Database">
          <InfoRow label="Schema version" value={database.schema_version} />
          <InfoRow label="Journal mode" value={database.journal_mode} />
          <InfoRow label="Accounts here" value={database.users} />
          <InfoRow label="Videos here" value={database.videos} />
          <InfoRow label="Videos from other servers" value={database.network_videos} />
        </Section>

        <Section title="Network and fediverse">
          <InfoRow label="Role" value={network.role ? `${network.role}${network.name ? ` of ${network.name}` : ''}` : 'not in a network'} />
          <InfoRow label="Servers with videos here" value={network.peers?.length ?? 0} />
          <InfoRow label="ActivityPub" value={network.activitypub?.enabled ? 'on' : 'off'} />
          <InfoRow label="Following" value={`${network.activitypub?.following ?? 0}${network.activitypub?.following_pending ? ` (+${network.activitypub.following_pending} waiting)` : ''}`} />
          <InfoRow label="Followers" value={network.activitypub?.followers} />
          <InfoRow label="Live streaming" value={live.enabled ? (live.server_answers ? 'on, MediaMTX answers' : "on, but MediaMTX doesn't answer") : 'off'} />
          <InfoRow label="Email" value={email.configured === null || email.configured === undefined ? 'Off' : email.configured ? 'set up' : 'not set up'} />
        </Section>

        <Section title="Job queue">
          {lanes.map(([lane, n]) => (
            <InfoRow key={lane} label={lane} value={`${n.queued} waiting · ${n.running} running · ${n.failed} failed · ${n.done} done`} />
          ))}
          {jobs.running?.length > 0 && <Text style={fs.hint}>{`Running now: ${jobs.running.map((j: any) => `${j.type} #${j.id}`).join(', ')}`}</Text>}
          {jobs.recent_failures?.length > 0 && (
            <>
              <Text style={fs.label}>Recent failures</Text>
              {jobs.recent_failures.map((f: any) => (
                <InfoRow key={f.id} label={`${f.type} #${f.id}${f.finished_at ? `, ${new Date(f.finished_at).toLocaleDateString()}` : ''}`} value={f.last_error} />
              ))}
            </>
          )}
        </Section>

        <Section title="Recent warnings and errors">
          {log.length === 0 ? (
            <Text style={fs.hint}>{`Nothing since the server started ${ago(app.started_at)}.`}</Text>
          ) : (
            <ScrollView horizontal style={{ backgroundColor: colors.bg2, borderRadius: 10 }} contentContainerStyle={{ padding: 10 }}>
              <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 11.5, lineHeight: 16 }} selectable>
                {log
                  .slice()
                  .reverse()
                  .map((l: any) => `${new Date(l.at).toLocaleString()}  ${l.level === 'error' ? 'ERROR' : 'warn '}  ${l.text}`)
                  .join('\n')}
              </Text>
            </ScrollView>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

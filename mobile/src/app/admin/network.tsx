import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { AdminTabs } from '@/components/AdminTabs';
import { Badge, Field, FieldRow, Input, ListItem, MoreMenu, Notice, NumberInput, Section, Select, Stats, Toggle, s as fs } from '@/components/Form';
import { confirm, prompt } from '@/components/Prompt';
import { Text } from '@/components/Text';
import { Avatar, Button, Chip, Empty, Loading, toast } from '@/components/ui';
import { ago } from '@/lib/format';
import { readable } from '@/lib/layout';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Tone = 'ok' | 'warn' | 'err' | 'neutral';
const MEMBER_STATUS: Record<string, [Tone, string]> = {
  approved: ['ok', 'Connected'],
  pending: ['warn', 'Waiting for the hub to approve'],
  suspended: ['err', 'Suspended by the hub'],
  banned: ['err', 'Banned by the hub'],
  removed: ['err', 'Removed from the network'],
};
const HUB_MEMBER_STATUS: Record<string, [Tone, string]> = {
  approved: ['ok', 'Active'],
  pending: ['warn', 'Waiting for approval'],
  suspended: ['warn', 'Suspended'],
  banned: ['err', 'Banned'],
};
const MINE: Record<string, [Tone, string]> = { approved: ['ok', 'Accepted'], pending: ['warn', 'Asked to peer'], rejected: ['err', 'Declined'] };
const THEIRS: Record<string, [Tone, string]> = { approved: ['ok', 'Accepts us'], pending: ['warn', 'Waiting for them'], rejected: ['err', 'Declined us'], left: ['neutral', 'Left the network'] };
const FOLLOW: Record<string, [Tone, string]> = { pending: ['warn', 'Waiting for them to accept'], accepted: ['ok', 'Following'], rejected: ['err', 'They declined'] };

function StatusBadge({ map, status, fallback = 'Not connected' }: { map: Record<string, [Tone, string]>; status?: string | null; fallback?: string }) {
  const [tone, label] = (status && map[status]) || ['neutral', status || fallback];
  return <Badge text={label} tone={tone} />;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const bare = (u: string) => u.replace(/^https?:\/\//, '');

/** Admin → Network, the website's /admin/network: joining or running a network, peers, block lists and the fediverse. */
export default function AdminNetwork() {
  const { api, user, refresh } = useSession();
  const [state, setState] = useState<any>(null);
  const [hubForm, setHubForm] = useState<any>(null);
  const [hubUrl, setHubUrl] = useState('');
  const [blockUrl, setBlockUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((s: any) => {
    setState(s);
    setHubForm(s.hub.settings);
    setHubUrl((u) => u || s.member.hub_url || '');
  }, []);
  useEffect(() => {
    api.get('/admin/network').then(apply).catch((e) => toast(e.message));
  }, [api, apply]);

  /** Runs an action that answers with the whole network state, as the website's run() does. */
  const run = async (key: string, fn: () => Promise<any>, ok?: string | ((s: any) => string)) => {
    setBusy(key);
    try {
      const s = await fn();
      apply(s);
      if (ok) toast(typeof ok === 'function' ? ok(s) : ok);
      refresh();
      return s;
    } catch (e: any) {
      toast(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!user?.is_admin) return <Empty icon="lock" title="Admins only">Network settings are for this server's admins.</Empty>;
  if (!state || !hubForm) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AdminTabs />
        <Loading />
      </View>
    );
  }

  const m = state.member;
  const hub = state.hub;
  const isHub = hub.enabled;
  const joined = m.enabled && !isHub;
  const hasHub = joined && !!m.status;
  const hubDirty = JSON.stringify(hubForm) !== JSON.stringify(hub.settings);
  const setHub = (patch: any) => setHubForm((f: any) => ({ ...f, ...patch }));
  const httpWarning = !String(state.self_url).startsWith('https://') && !state.allow_private;
  const memberAction = (inst: any, body: any, msg?: string) => run(`m${inst.id}`, () => api.patch(`/admin/network/hub/members/${inst.id}`, body), msg);
  const memberPatch = (body: any) => run('acc', () => api.patch('/admin/network/member', body));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView contentContainerStyle={[{ padding: 16, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {isHub && <Badge text="This instance is the hub" tone="ok" />}
          {joined && <StatusBadge map={MEMBER_STATUS} status={m.status} />}
        </View>
        <Text style={fs.hint}>
          Everyone hosts their own videos, and instances in a network browse and search each other's videos, with likes, comments and subscriptions across
          instances. A hub is the easy way in and can moderate the network, but instances also peer with each other directly, so the network keeps working if
          the hub goes away.
        </Text>
        <Text style={{ color: colors.text }}>
          {"This instance's address: "}
          <Text style={{ fontFamily: 'monospace' }}>{state.self_url}</Text>
          {!state.public_url_set && <Text style={fs.hint}>{" (taken from the address you're using; set the Public URL under Overview to pin it)"}</Text>}
        </Text>
        {httpWarning && <Notice tone="warn" icon="warning-amber">Networks need HTTPS. Set this site's Public URL to its https:// address under Overview first.</Notice>}

        {!isHub && (
          <Section title="Join a network">
            {joined ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={fs.itemTitle}>{m.network_name || (hasHub ? 'Network' : 'Peer-to-peer network')}</Text>
                    {hasHub ? (
                      <Text style={fs.hint}>
                        {'Hub: '}
                        <Text style={{ color: colors.link }} onPress={() => Linking.openURL(m.hub_url)}>
                          {m.hub_url}
                        </Text>
                      </Text>
                    ) : (
                      <Text style={fs.hint}>No hub: connected through direct peers</Text>
                    )}
                  </View>
                  {hasHub ? <StatusBadge map={MEMBER_STATUS} status={m.status} /> : <Badge text={state.active ? 'Connected' : 'Waiting for peers'} tone={state.active ? 'ok' : 'warn'} />}
                </View>
                {!!m.note && <Text style={{ color: colors.err }}>{`Hub says: ${m.note}`}</Text>}
                {!!m.announcement && <Notice>{m.announcement}</Notice>}
                <Stats
                  items={[
                    { n: m.video_count, l: 'Videos from other instances' },
                    { n: m.last_sync_at ? ago(m.last_sync_at) : 'never', l: 'Last sync' },
                    { n: ['comments', 'likes', 'subscriptions'].filter((k) => m.policy?.[k]).join(', ') || 'browsing only', l: 'Network allows' },
                  ]}
                />
                {!!m.last_error && <Text style={{ color: colors.err }}>{`Last sync failed: ${m.last_error}`}</Text>}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Button title="Sync now" icon="refresh" small disabled={!!busy} onPress={() => run('sync', () => api.post('/admin/network/sync'), 'Synced with the hub')} />
                  {hasHub && (
                    <Button
                      title="Leave hub only"
                      small
                      kind="ghost"
                      disabled={!!busy}
                      onPress={async () =>
                        (await confirm('Leave the hub?', 'You stay connected to your direct peers.', { confirmLabel: 'Leave hub' })) &&
                        run('leavehub', () => api.post('/admin/network/leave', { keep_peers: true }), 'Left the hub; direct peers kept')
                      }
                    />
                  )}
                  <Button
                    title="Leave network"
                    small
                    kind="ghost"
                    disabled={!!busy}
                    onPress={async () =>
                      (await confirm('Leave the network?', 'Videos from other instances disappear from this site, and yours from theirs.', { confirmLabel: 'Leave', destructive: true })) &&
                      run('leave', () => api.post('/admin/network/leave'), 'Left the network')
                    }
                  />
                </View>
              </>
            ) : (
              <>
                <Text style={fs.hint}>Off by default. While you're not in a network, nothing is shared and no other instance is contacted.</Text>
                <Field label="Hub or instance address" hint="A hub, or any instance that is already in the network. The rest of the network is found from there.">
                  <Input value={hubUrl} onChangeText={setHubUrl} placeholder="https://clips.irc.so" autoCapitalize="none" keyboardType="url" />
                </Field>
                <Button
                  title={busy === 'join' ? 'Joining…' : 'Join network'}
                  kind="accent"
                  disabled={busy === 'join' || !hubUrl.trim()}
                  style={{ alignSelf: 'flex-start' }}
                  onPress={() =>
                    run('join', () => api.post('/admin/network/join', { url: hubUrl }), (s) =>
                      s.member.status === 'approved'
                        ? `Joined ${s.member.network_name || 'the network'}`
                        : s.active
                          ? 'Connected to the network'
                          : s.member.status === 'pending'
                            ? 'Join request sent; the hub admin needs to approve it'
                            : 'Request sent; the instance admin needs to accept it',
                    )
                  }
                />
              </>
            )}
            <Text style={[fs.label, { marginTop: 6 }]}>Accept from other instances</Text>
            <Toggle label="Comments" hint="People on other instances can comment on your videos." value={!!m.accept?.comments} onChange={(v) => memberPatch({ accept_comments: v })} />
            <Toggle label="Likes" value={!!m.accept?.likes} onChange={(v) => memberPatch({ accept_likes: v })} />
            <Toggle label="Subscriptions" value={!!m.accept?.subscriptions} onChange={(v) => memberPatch({ accept_subscriptions: v })} />
          </Section>
        )}

        <Section title="Run the network (hub mode)">
          <Toggle
            label="This instance is the hub"
            hint={joined ? 'Leave your current network first.' : 'Other instances join here. Your own videos stay part of the network too.'}
            value={isHub}
            disabled={joined || !!busy}
            onChange={async (v) =>
              (v || (await confirm('Turn off hub mode?', 'Every instance in the network loses access to the shared index until you turn it back on.', { confirmLabel: 'Turn off', destructive: true }))) &&
              run('hub', () => api.patch('/admin/network/hub', { enabled: v }), v ? 'Hub mode is on' : 'Hub mode is off')
            }
          />
          {isHub && (
            <>
              <Field label="Network name">
                <Input maxLength={60} value={hubForm.network_name} onChangeText={(t) => setHub({ network_name: t })} />
              </Field>
              <Text style={fs.label}>Joining</Text>
              <Toggle label="Accept new instances" hint="Turn off to lock the network down. Existing members keep working." value={!!hubForm.accept_new} onChange={(v) => setHub({ accept_new: v })} />
              <Toggle
                label="Require my approval"
                hint="New instances wait in the list below until you approve them."
                value={!!hubForm.require_approval}
                disabled={!hubForm.accept_new}
                onChange={(v) => setHub({ require_approval: v })}
              />
              <Toggle label="HTTPS only" hint="Refuse instances that aren't served over HTTPS." value={!!hubForm.require_https} onChange={(v) => setHub({ require_https: v })} />
              <Text style={fs.label}>Across the whole network</Text>
              <Toggle label="Comments between instances" value={!!hubForm.allow_comments} onChange={(v) => setHub({ allow_comments: v })} />
              <Toggle label="Likes between instances" value={!!hubForm.allow_likes} onChange={(v) => setHub({ allow_likes: v })} />
              <Toggle label="Subscriptions between instances" value={!!hubForm.allow_subscriptions} onChange={(v) => setHub({ allow_subscriptions: v })} />
              <Toggle label="Include this instance's videos" hint="Share the hub's own public videos with the network." value={!!hubForm.include_own_videos} onChange={(v) => setHub({ include_own_videos: v })} />
              <FieldRow>
                <Field label="Max videos per instance" style={{ flex: 1, minWidth: 150 }}>
                  <NumberInput value={hubForm.max_videos_per_instance} onChangeText={(t) => setHub({ max_videos_per_instance: t })} />
                </Field>
                <Field label="Sync every (minutes)" style={{ flex: 1, minWidth: 150 }}>
                  <NumberInput value={hubForm.sync_minutes} onChangeText={(t) => setHub({ sync_minutes: t })} />
                </Field>
              </FieldRow>
              <Field label="Announcement">
                <Input multiline maxLength={1000} value={hubForm.announcement} onChangeText={(t) => setHub({ announcement: t })} placeholder="Shown at the top of the Network page on every instance" />
              </Field>
              <Button
                title="Save hub settings"
                kind="accent"
                disabled={!hubDirty || busy === 'hubsave'}
                style={{ alignSelf: 'flex-start' }}
                onPress={() => run('hubsave', () => api.patch('/admin/network/hub', hubForm), 'Hub settings saved')}
              />
            </>
          )}
        </Section>

        <Section
          title="Fediverse sharing"
          hint="Servers in the network can pass on the PeerTube channels and servers they follow, so every server that takes them shows those videos too. Each side opts in. Likes and comments still go straight to the video's own server."
        >
          <Toggle
            label="Share what this server follows"
            hint="Other OurTube servers that take shares get the fediverse videos followed here (not the ones this server got from its peers)."
            value={!!m.sharing?.out}
            onChange={(v) => run('share', () => api.patch('/admin/network/member', { share_out: v }))}
          />
          <Toggle
            label="Show what other servers share"
            hint={`The fediverse videos peers pass on show here as well, tagged with their own server.${m.sharing?.shared_here ? ` ${m.sharing.shared_here} here now.` : ''} Turning this off removes them.`}
            value={!!m.sharing?.in}
            onChange={(v) => run('share', () => api.patch('/admin/network/member', { share_in: v }))}
          />
        </Section>

        {isHub && (
          <Section
            title={`Instances in the network (${hub.members.length})`}
            right={<Button title="Sync all" icon="refresh" small disabled={!!busy} onPress={() => run('syncall', () => api.post('/admin/network/sync'), 'Pulled every instance')} />}
          >
            {hub.members.length === 0 ? (
              <Text style={fs.hint}>{`No instances have joined yet. Point another OurTube server at ${state.self_url} under Admin → Network.`}</Text>
            ) : (
              hub.members.map((i: any) => (
                <View key={i.id} style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={[fs.itemTitle, { color: colors.link }]} onPress={() => Linking.openURL(i.url)}>
                      {i.name}
                    </Text>
                    <StatusBadge map={HUB_MEMBER_STATUS} status={i.status} />
                    {!i.listed && <Badge text="Videos hidden" />}
                    {!i.allow_interactions && <Badge text="No likes or comments" />}
                  </View>
                  <Text style={fs.hint}>
                    {`${bare(i.url)} · ${plural(i.video_count, 'video')} · joined ${ago(i.created_at)}${i.last_seen_at ? ` · seen ${ago(i.last_seen_at)}` : ''}${i.version ? ` · v${i.version}` : ''}`}
                  </Text>
                  {!!i.note && <Text style={fs.hint}>{`Note: ${i.note}`}</Text>}
                  {!!i.last_error && <Text style={{ color: colors.err, fontSize: 12.5 }}>{i.last_error}</Text>}
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    {i.status === 'pending' && <Button title="Approve" small kind="accent" onPress={() => memberAction(i, { status: 'approved' }, `Approved ${i.name}`)} />}
                    {i.status === 'approved' && (
                      <Button
                        title="Suspend"
                        small
                        onPress={async () => {
                          const note = await prompt({ title: `Suspend ${i.name}?`, message: 'Its videos leave the network until you unsuspend it. The reason is shown to them.', placeholder: 'Reason', confirmLabel: 'Suspend' });
                          if (note !== null) memberAction(i, { status: 'suspended', note }, `Suspended ${i.name}`);
                        }}
                      />
                    )}
                    {(i.status === 'suspended' || i.status === 'banned') && (
                      <Button title={i.status === 'banned' ? 'Unban' : 'Unsuspend'} small onPress={() => memberAction(i, { status: 'approved', note: '' }, `${i.name} is active again`)} />
                    )}
                    {i.status !== 'banned' && (
                      <Button
                        title="Ban"
                        small
                        kind="danger"
                        onPress={async () => {
                          const note = await prompt({ title: `Ban ${i.name} from the network?`, message: "It can't rejoin until you unban it.", placeholder: 'Reason', confirmLabel: 'Ban' });
                          if (note !== null) memberAction(i, { status: 'banned', note }, `Banned ${i.name}`);
                        }}
                      />
                    )}
                    <MoreMenu
                      items={[
                        { label: i.allow_interactions ? 'Stop its likes and comments' : 'Allow its likes and comments', onPress: () => memberAction(i, { allow_interactions: !i.allow_interactions }) },
                        { label: i.listed ? 'Hide its videos from the network' : 'Show its videos in the network', onPress: () => memberAction(i, { listed: !i.listed }) },
                        { label: 'Sync now', onPress: () => run(`s${i.id}`, () => api.post(`/admin/network/hub/members/${i.id}/sync`), `Pulled ${i.name}`) },
                        {
                          label: 'Remove from the list',
                          destructive: true,
                          onPress: async () =>
                            (await confirm(`Remove ${i.name}?`, 'It can join again later (unless the network is locked).', { confirmLabel: 'Remove', destructive: true })) &&
                            run(`d${i.id}`, () => api.del(`/admin/network/hub/members/${i.id}`), `Removed ${i.name}`),
                        },
                      ]}
                    />
                  </View>
                </View>
              ))
            )}
          </Section>
        )}

        {state.participating && (
          <>
            <PeersPanel state={state} run={run} busy={busy} />
            <AdmissionPanel key={state.max_peers} state={state} run={run} />
            <BlocklistsPanel state={state} run={run} busy={busy} />
          </>
        )}

        <FediverseAdmin />

        <Section
          title="Blocked instances"
          hint={`Blocking an instance hides its videos here and refuses likes, comments and subscriptions from its people.${isHub ? ' To remove an instance from the whole network, ban it above.' : ''}`}
        >
          <FieldRow>
            <Input value={blockUrl} onChangeText={setBlockUrl} placeholder="clips.example.com" autoCapitalize="none" keyboardType="url" style={{ flex: 1, minWidth: 180 }} />
            <Button
              title="Block"
              disabled={!blockUrl.trim() || busy === 'block'}
              onPress={() => run('block', () => api.post('/admin/network/instances/block', { url: blockUrl }), 'Instance blocked').then((s) => s && setBlockUrl(''))}
            />
          </FieldRow>
          {state.instances.map((i: any) => (
            <ListItem
              key={i.id}
              title={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Text style={fs.itemTitle}>{i.name}</Text>
                  {i.blocked && <Badge text="Blocked" tone="err" />}
                </View>
              }
              sub={`${bare(i.url)}${!i.blocked ? ` · ${plural(i.video_count, 'video')}` : ''}${i.block_reason ? ` · ${i.block_reason}` : ''}${i.block_source ? ' · from a list you follow' : ''}`}
              right={
                <Button
                  title={i.blocked ? 'Unblock' : 'Block'}
                  small
                  kind={i.blocked ? 'secondary' : 'ghost'}
                  onPress={async () => {
                    if (i.blocked) return run(`b${i.id}`, () => api.patch(`/admin/network/instances/${i.id}`, { blocked: false }), `Unblocked ${i.name}`);
                    const reason = await prompt({ title: `Block ${i.name}?`, message: 'Reason (optional, only you see it).', confirmLabel: 'Block' });
                    if (reason !== null) run(`b${i.id}`, () => api.patch(`/admin/network/instances/${i.id}`, { blocked: true, reason }), `Blocked ${i.name}`);
                  }}
                />
              }
            />
          ))}
          {state.instances.length === 0 && <Text style={fs.hint}>{joined ? 'No other instances in the network yet.' : 'Nothing blocked.'}</Text>}
        </Section>

        {state.hidden.length > 0 && (
          <Section title={`Hidden videos (${state.hidden.length})`} hint={isHub ? 'Hidden from the whole network.' : 'Hidden on this site only.'}>
            {state.hidden.map((h: any) => (
              <ListItem
                key={`${h.instance_id}-${h.remote_id}`}
                title={h.title}
                sub={h.peer_name}
                onPress={h.watch_url ? () => Linking.openURL(h.watch_url) : undefined}
                right={
                  <Button
                    title="Show again"
                    small
                    onPress={() => run(`h${h.remote_id}`, () => api.patch(`/admin/network/videos/${h.instance_id}/${h.remote_id}`, { hidden: false }), 'Video shown again')}
                  />
                }
              />
            ))}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

type Run = (key: string, fn: () => Promise<any>, ok?: string | ((s: any) => string)) => Promise<any>;

/** Instances this one peers with directly: status both ways, health, and actions. */
function PeersPanel({ state, run, busy }: { state: any; run: Run; busy: string | null }) {
  const { api } = useSession();
  const [url, setUrl] = useState('');
  const peers: any[] = state.peers;
  const waiting = peers.filter((p) => p.peer_status === 'pending');
  const act = (p: any, body: any, msg?: string) => run(`p${p.id}`, () => api.patch(`/admin/network/peers/${p.id}`, body), msg);
  return (
    <Section
      title={`Direct peers (${peers.filter((p) => p.direct).length} connected${waiting.length ? `, ${waiting.length} waiting` : ''})`}
      hint="Instances this one exchanges videos with directly, so the network keeps working without a hub. Each one's key is checked at its own address. New peers are found through the hub and through other peers."
    >
      <FieldRow>
        <Input value={url} onChangeText={setUrl} placeholder="clips.example.com" autoCapitalize="none" keyboardType="url" style={{ flex: 1, minWidth: 180 }} />
        <Button
          title="Peer with it"
          disabled={!url.trim() || busy === 'peer'}
          onPress={() =>
            run('peer', () => api.post('/admin/network/peers', { url }), (s) => {
              const p = s.peers.find((x: any) => x.url.includes(url.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')));
              return p?.remote_status === 'approved' ? `Peering with ${p.name}` : 'Request sent; their admin needs to accept it';
            }).then((s) => s && setUrl(''))
          }
        />
      </FieldRow>
      {peers.map((p) => (
        <View key={p.id} style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={fs.itemTitle}>{p.name}</Text>
            {p.direct && <Badge text="Connected" tone="ok" />}
            {!p.direct && !!p.peer_status && MINE[p.peer_status] && <StatusBadge map={MINE} status={p.peer_status} />}
            {!p.direct && !!p.remote_status && THEIRS[p.remote_status] && <StatusBadge map={THEIRS} status={p.remote_status} />}
            {p.in_hub && <Badge text="In the hub" />}
            {p.protocol < 3 && <Badge text="Older version" />}
          </View>
          <Text style={fs.hint}>
            {`${bare(p.url)} · ${plural(p.video_count, 'video')}${p.last_ok_at ? ` · synced ${ago(p.last_ok_at)}` : ' · not synced yet'}${
              p.source === 'peer' ? ' · found through a peer' : p.source === 'hub' ? ' · from the hub' : p.source === 'inbound' ? ' · asked us' : ''
            }`}
          </Text>
          {!!p.last_error && <Text style={{ color: colors.err, fontSize: 12.5 }}>{p.last_error}</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {p.peer_status === 'pending' && (
              <>
                <Button title="Accept" small kind="accent" disabled={!!busy} onPress={() => act(p, { status: 'approved' }, `Accepted ${p.name}`)} />
                <Button title="Decline" small disabled={!!busy} onPress={() => act(p, { status: 'rejected' }, `Declined ${p.name}`)} />
              </>
            )}
            {p.peer_status === 'rejected' && <Button title="Accept" small disabled={!!busy} onPress={() => act(p, { status: 'approved' }, `Accepted ${p.name}`)} />}
            <Button
              title="Forget"
              small
              kind="ghost"
              disabled={!!busy}
              onPress={async () =>
                (await confirm(`Forget ${p.name}?`, 'Its videos disappear here until you peer again.', { confirmLabel: 'Forget', destructive: true })) &&
                run(`f${p.id}`, () => api.del(`/admin/network/peers/${p.id}`), `Forgot ${p.name}`)
              }
            />
          </View>
        </View>
      ))}
      {peers.length === 0 && <Text style={fs.hint}>No direct peers yet.</Text>}
    </Section>
  );
}

/** Who may peer with this instance. On a hub the joining switches decide that instead. */
function AdmissionPanel({ state, run }: { state: any; run: Run }) {
  const { api } = useSession();
  const a = state.admission;
  const set = (body: any, msg?: string) => run('adm', () => api.patch('/admin/network/admission', body), msg);
  const [max, setMax] = useState(String(state.max_peers));
  return (
    <Section title="Who can peer with this instance">
      {state.role === 'hub' ? (
        <Text style={fs.hint}>On the hub, the joining switches above also decide who can peer with it directly.</Text>
      ) : (
        <>
          <Toggle
            label="Accept new instances"
            hint="Turn off to lock down: instances you already peer with keep working, nobody new gets in."
            value={!!a.accept_new}
            onChange={(v) => set({ accept_new: v }, v ? 'Accepting new instances' : 'Locked down')}
          />
          <Toggle label="Ask me first" hint="New instances wait in the peer list until you accept them." value={!!a.require_approval} onChange={(v) => set({ require_approval: v })} />
          <Toggle label="HTTPS only" hint="Refuse instances that aren't served over HTTPS." value={!!a.require_https} onChange={(v) => set({ require_https: v })} />
        </>
      )}
      <Toggle
        label="Publish my block list"
        hint="Other instances can follow the instances you block (with your reasons) at /api/network/blocklist."
        value={!!state.publish_blocklist}
        onChange={(v) => set({ publish_blocklist: v })}
      />
      <FieldRow>
        <Field label="Most peers" style={{ width: 140 }}>
          <NumberInput value={max} onChangeText={setMax} />
        </Field>
        <Button title="Save" small disabled={String(state.max_peers) === max} onPress={() => set({ max_peers: max }, 'Saved')} style={{ alignSelf: 'flex-end' }} />
      </FieldRow>
    </Section>
  );
}

/** Block lists this instance follows, with entries waiting for review. */
function BlocklistsPanel({ state, run, busy }: { state: any; run: Run; busy: string | null }) {
  const { api } = useSession();
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'review' | 'auto'>('review');
  const patch = (b: any, body: any, msg?: string) => run(`bl${b.id}`, () => api.patch(`/admin/network/blocklists/${b.id}`, body), msg);
  return (
    <Section
      title="Block lists you follow"
      hint="Follow another instance's list of blocked instances. Automatic lists apply right away and undo themselves when the source takes a block back; review lists wait for you. Joining a hub follows the hub's list automatically, so its bans reach you even when you pull from peers directly."
    >
      <Input value={url} onChangeText={setUrl} placeholder="clips.example.com" autoCapitalize="none" keyboardType="url" />
      <FieldRow>
        <View style={{ flex: 1, minWidth: 170 }}>
          <Select
            value={mode}
            options={[
              { value: 'review', label: 'Review first' },
              { value: 'auto', label: 'Apply automatically' },
            ]}
            onChange={setMode}
          />
        </View>
        <Button
          title="Follow"
          disabled={!url.trim() || busy === 'blsub'}
          onPress={() => run('blsub', () => api.post('/admin/network/blocklists', { url, mode }), 'Following the list').then((s) => s && setUrl(''))}
        />
      </FieldRow>
      {state.blocklists.map((b: any) => (
        <View key={b.id} style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text style={fs.itemTitle}>{bare(b.url)}</Text>
            <Badge text={b.mode === 'auto' ? 'Automatic' : 'Review'} tone={b.mode === 'auto' ? 'ok' : 'neutral'} />
          </View>
          <Text style={fs.hint}>{`${b.applied} applied${b.pending.length ? ` · ${b.pending.length} waiting` : ''}${b.last_fetched_at ? ` · checked ${ago(b.last_fetched_at)}` : ''}`}</Text>
          {!!b.last_error && <Text style={{ color: colors.err, fontSize: 12.5 }}>{b.last_error}</Text>}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button title={b.mode === 'auto' ? 'Review first' : 'Apply automatically'} small disabled={!!busy} onPress={() => patch(b, { mode: b.mode === 'auto' ? 'review' : 'auto' })} />
            <Button title="Check now" icon="refresh" small disabled={!!busy} onPress={() => patch(b, { refresh: true }, 'Checked')} />
            <Button
              title="Stop following"
              small
              kind="ghost"
              disabled={!!busy}
              onPress={async () =>
                (await confirm(`Stop following ${b.url}?`, 'Blocks that came from it are lifted.', { confirmLabel: 'Stop', destructive: true })) &&
                run(`bld${b.id}`, () => api.del(`/admin/network/blocklists/${b.id}`), 'Stopped following')
              }
            />
          </View>
          {b.pending.map((e: any) => (
            <View key={`${e.kind}${e.target}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10 }}>
              <Text style={{ flex: 1, color: colors.text }}>
                {e.kind === 'video' ? 'Video ' : ''}
                <Text style={{ fontWeight: '700' }}>{bare(e.target)}</Text>
                {e.reason ? <Text style={fs.hint}>{` · ${e.reason}`}</Text> : null}
              </Text>
              <Button title="Apply" small disabled={!!busy} onPress={() => patch(b, { entry: { kind: e.kind, target: e.target, status: 'applied' } }, 'Applied')} />
              <Button title="Ignore" small kind="ghost" disabled={!!busy} onPress={() => patch(b, { entry: { kind: e.kind, target: e.target, status: 'ignored' } })} />
            </View>
          ))}
        </View>
      ))}
      {state.blocklists.length === 0 && <Text style={fs.hint}>Not following any lists.</Text>}
    </Section>
  );
}

// PeerTube's video categories, which servers in its directory list as their topics.
const PEERTUBE_TOPICS: [number, string][] = [
  [7, 'Gaming'], [12, 'How to'], [15, 'Science & tech'], [9, 'Comedy'], [2, 'Films'], [6, 'Travel'], [1, 'Music'], [4, 'Art'],
  [13, 'Education'], [16, 'Animals'], [18, 'Food'], [5, 'Sports'], [3, 'Vehicles'], [10, 'Entertainment'], [8, 'People'],
  [17, 'Kids'], [11, 'News & politics'], [14, 'Activism'],
];
const TOPIC_NAME = Object.fromEntries(PEERTUBE_TOPICS);
const LANGUAGES = [['', 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['ja', 'Japanese']];

/** Admin: ActivityPub on or off, and following whole servers (the way PeerTube servers mirror each other). */
function FediverseAdmin() {
  const { api } = useSession();
  const [s, setS] = useState<any>(null);
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => {
    api.get('/admin/fediverse').then(setS).catch((e) => toast(e.message));
  }, [api]);
  if (!s) return null;
  const run = async (fn: () => Promise<any>, msg?: string) => {
    setBusy(true);
    try {
      setS(await fn());
      if (msg) toast(msg);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Fediverse (ActivityPub)"
      hint="Lets Mastodon, PeerTube and other fediverse servers follow channels here, watch and comment on videos, and lets people here follow channels there. Blocked instances below are blocked here too."
    >
      <Toggle
        label="Speak ActivityPub"
        hint={s.enabled ? `This server is ${s.instance_handle}.` : 'Off: this site is invisible to the fediverse.'}
        value={!!s.enabled}
        disabled={busy}
        onChange={(v) => run(() => api.patch('/admin/fediverse', { enabled: v }))}
      />
      {s.enabled && !s.public_url_set && <Notice tone="warn" icon="warning-amber">Set the Public URL under Overview, so fediverse servers can reach this site at a stable https:// address.</Notice>}
      <Stats
        items={[
          { n: `${s.followers?.channels ?? 0} · ${s.followers?.instance ?? 0}`, l: 'Fediverse followers: of channels · of this server' },
          { n: s.videos, l: 'Videos from the fediverse' },
        ]}
      />
      <Text style={fs.label}>Follow a whole server</Text>
      <Text style={fs.hint}>Brings in every public video of a PeerTube server, the way PeerTube servers follow each other.</Text>
      <FieldRow>
        <Input value={server} onChangeText={setServer} placeholder="peertube.example" autoCapitalize="none" keyboardType="url" style={{ flex: 1, minWidth: 180 }} />
        <Button
          title="Follow"
          disabled={busy || !server.trim() || !s.enabled}
          onPress={() => run(() => api.post('/admin/fediverse/follow', { server }), 'Follow request sent').then(() => setServer(''))}
        />
      </FieldRow>
      <Button title={browsing ? 'Close the PeerTube directory' : 'Browse the PeerTube directory'} icon="search" kind="ghost" onPress={() => setBrowsing((b) => !b)} style={{ alignSelf: 'flex-start' }} />
      {browsing && <PeerTubeDirectory enabled={!!s.enabled} onFollowed={setS} />}
      {s.servers?.map((a: any) => (
        <ListItem
          key={a.id}
          title={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={fs.itemTitle}>{a.name}</Text>
              <StatusBadge map={FOLLOW} status={a.status} />
            </View>
          }
          sub={a.handle}
          right={<Button title="Unfollow" small kind="ghost" disabled={busy} onPress={() => run(() => api.del('/admin/fediverse/follow', { actor: a.id }))} />}
        />
      ))}
    </Section>
  );
}

/** Finds PeerTube servers in joinpeertube.org's directory and follows them, a tap each. */
function PeerTubeDirectory({ enabled, onFollowed }: { enabled: boolean; onFollowed: (s: any) => void }) {
  const { api } = useSession();
  const [filters, setFilters] = useState({ search: '', language: 'en', categories: [] as number[], sort: '-totalLocalVideos', nsfw: false });
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    const q = new URLSearchParams({ page: String(page), sort: filters.sort, language: filters.language, search: filters.search, categories: filters.categories.join(',') });
    if (filters.nsfw) q.set('nsfw', 'show');
    api
      .get(`/admin/fediverse/directory?${q}`)
      .then((r: any) => !dead && setResult((prev: any) => (page > 1 && prev ? { ...r, servers: [...prev.servers, ...r.servers] } : r)))
      .catch((e) => !dead && toast(e.message))
      .finally(() => !dead && setLoading(false));
    return () => {
      dead = true;
    };
  }, [api, filters, page]);

  const set = (patch: Partial<typeof filters>) => {
    setPage(1);
    setFilters((f) => ({ ...f, ...patch }));
  };
  const toggleTopic = (id: number) => set({ categories: filters.categories.includes(id) ? filters.categories.filter((c) => c !== id) : [...filters.categories, id] });
  const follow = async (srv: any) => {
    setBusy(srv.host);
    try {
      onFollowed(await api.post('/admin/fediverse/follow', { server: srv.host }));
      setResult((r: any) => ({ ...r, servers: r.servers.map((x: any) => (x.host === srv.host ? { ...x, following: 'pending' } : x)) }));
      toast(`Asked to follow ${srv.name}`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <FieldRow>
        <Input value={search} onChangeText={setSearch} placeholder="Search servers by name or description" onSubmitEditing={() => set({ search: search.trim() })} style={{ flex: 1, minWidth: 200 }} />
        <Button title="Search" onPress={() => set({ search: search.trim() })} />
      </FieldRow>
      <FieldRow>
        <View style={{ flex: 1, minWidth: 150 }}>
          <Select value={filters.language} options={LANGUAGES.map(([v, l]) => ({ value: v, label: l }))} onChange={(v) => set({ language: v })} />
        </View>
        <View style={{ flex: 1, minWidth: 150 }}>
          <Select
            value={filters.sort}
            options={[
              { value: '-totalLocalVideos', label: 'Most videos' },
              { value: '-totalInstanceFollowers', label: 'Most followed' },
              { value: '-totalUsers', label: 'Most people' },
              { value: '-createdAt', label: 'Newest' },
            ]}
            onChange={(v) => set({ sort: v })}
          />
        </View>
      </FieldRow>
      <Toggle label="Include servers that show NSFW" value={filters.nsfw} onChange={(v) => set({ nsfw: v })} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {PEERTUBE_TOPICS.map(([id, label]) => (
          <Chip key={id} label={label} active={filters.categories.includes(id)} onPress={() => toggleTopic(id)} />
        ))}
      </View>
      {!!result && (
        <Text style={fs.hint}>{`${(result.total || 0).toLocaleString()} ${result.total === 1 ? 'server' : 'servers'} in the directory match. Videos marked sensitive stay out either way.`}</Text>
      )}
      {result?.servers.map((srv: any) => (
        <View key={srv.host} style={{ flexDirection: 'row', gap: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.hairline }}>
          {srv.avatar_url ? <Image source={{ uri: srv.avatar_url }} style={{ width: 40, height: 40, borderRadius: 8 }} /> : <Avatar uri={null} name={srv.name} size={40} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={fs.itemTitle}>
              {srv.name}{' '}
              <Text style={{ color: colors.link, fontWeight: '400', fontSize: 13 }} onPress={() => Linking.openURL(`https://${srv.host}`)}>
                {srv.host}
              </Text>
            </Text>
            {!!srv.description && (
              <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={3}>
                {srv.description}
              </Text>
            )}
            <Text style={fs.hint}>
              {`${(srv.videos || 0).toLocaleString()} videos${srv.languages?.length ? ` · ${srv.languages.join(', ')}` : ''}${
                srv.categories?.length ? ` · ${srv.categories.map((c: number) => TOPIC_NAME[c]).filter(Boolean).slice(0, 4).join(', ')}` : ''
              }${srv.nsfw_policy === 'display' ? ' · shows NSFW' : ''}`}
            </Text>
          </View>
          <View style={{ justifyContent: 'center' }}>
            {srv.blocked ? (
              <Badge text="Blocked" tone="err" />
            ) : srv.following ? (
              <StatusBadge map={{ accepted: ['ok', 'Following'], pending: ['warn', 'Waiting'], rejected: ['err', 'Declined'] }} status={srv.following} />
            ) : (
              <Button title="Follow" small disabled={!enabled || busy === srv.host} onPress={() => follow(srv)} />
            )}
          </View>
        </View>
      ))}
      {loading && <Loading style={{ paddingVertical: 16 }} />}
      {!!result && !loading && result.servers.length < result.total && <Button title="Show more" kind="ghost" onPress={() => setPage((p) => p + 1)} style={{ alignSelf: 'flex-start' }} />}
    </View>
  );
}

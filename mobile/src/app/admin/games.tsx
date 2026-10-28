import { useCallback, useEffect, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AdminTabs } from '@/components/AdminTabs';
import { Badge, Field, FieldRow, Input, Section, Select, Toggle, isOn, s as fs } from '@/components/Form';
import { confirm } from '@/components/Prompt';
import { Heading, Text } from '@/components/Text';
import { Button, Chip, Empty, Icon, Loading, toast } from '@/components/ui';
import { readable } from '@/lib/layout';
import { pickFile } from '@/lib/pick';
import { useSession } from '@/lib/session';
import { colors } from '@/lib/theme';

type Game = {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[];
  artwork_url: string | null;
  logo_url?: string | null;
  hero_url?: string | null;
  video_count: number;
  network_count: number;
  from_hub?: boolean;
  sgdb_id?: number | null;
};
type Sgdb = { configured: boolean; auto: boolean };

/** Games, the website's /admin/games: the catalog videos are filed under, with artwork from SteamGridDB. */
export default function AdminGames() {
  const { api, user } = useSession();
  const [games, setGames] = useState<Game[] | null>(null);
  const [catalog, setCatalog] = useState<any>({});
  const [sgdb, setSgdb] = useState<Sgdb>({ configured: false, auto: false });
  const [draft, setDraft] = useState({ name: '', short_name: '', aliases: '' });
  const load = useCallback(
    () =>
      api
        .get<any>('/games')
        .then((r) => {
          setGames(r.games);
          setCatalog(r.catalog || {});
          setSgdb(r.steamgriddb || { configured: false, auto: false });
        })
        .catch((e) => toast(e.message)),
    [api],
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!user?.is_moderator && !user?.is_admin) return <Empty icon="lock" title="Moderators only">The game catalog is kept by moderators and admins.</Empty>;
  let hubName: string | null = null;
  try {
    hubName = catalog.hub_url ? new URL(catalog.hub_url).host : null;
  } catch {
    hubName = null;
  }
  const create = async () => {
    if (!draft.name.trim()) return toast('Give the game a name');
    try {
      await api.post('/games', draft);
      setDraft({ name: '', short_name: '', aliases: '' });
      load();
    } catch (e: any) {
      toast(e.message);
    }
  };
  const merge = async (g: Game, intoId: string) => {
    const into = (games || []).find((x) => x.id === intoId);
    if (!into) return;
    const everywhere = catalog.is_hub ? " Members' copies of it merge too, at their next sync." : '';
    if (!(await confirm(`Merge ${g.name} into ${into.name}?`, `Its ${g.video_count} video(s) move to ${into.name}, and ${g.name} goes.${everywhere}`, { confirmLabel: 'Merge' }))) return;
    try {
      const { game } = await api.post<{ game: Game }>(`/games/${g.id}/merge`, { into: intoId });
      setGames((list) => (list || []).filter((x) => x.id !== g.id).map((x) => (x.id === game.id ? game : x)));
      toast(`Merged into ${game.name}`);
    } catch (e: any) {
      toast(e.message);
    }
  };
  const remove = async (g: Game) => {
    const everywhere = catalog.is_hub ? ' It also leaves the catalog of every instance in the network.' : '';
    if (!(await confirm(`Delete ${g.name}?`, `Its ${g.video_count} video(s) stay, without a game.${everywhere}`, { confirmLabel: 'Delete', destructive: true }))) return;
    try {
      await api.del(`/games/${g.id}`);
      setGames((list) => (list || []).filter((x) => x.id !== g.id));
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminTabs />
      <ScrollView contentContainerStyle={[{ padding: 16, gap: 14, paddingBottom: 40 }, readable]} keyboardShouldPersistTaps="handled">
        <Text style={fs.hint}>
          Videos can be filed under these games. The short name becomes the game's id, which other instances in the network use to group videos, so keep it
          to the common name (like mw3 or valorant). Add other spellings under "Also known as".
        </Text>
        {catalog.is_hub && <Text style={fs.hint}>This list is the network's catalog: members get these games automatically, and a game deleted here goes from theirs too.</Text>}
        {!!hubName && <Text style={fs.hint}>{`Games marked "From ${hubName}" come from the network hub's catalog and stay in step with it. Games you add here are this site's own.`}</Text>}
        <SteamGridSettings sgdb={sgdb} onChanged={load} />
        <Section title="Add a game">
          <Field label="Name">
            <Input value={draft.name} maxLength={80} onChangeText={(t) => setDraft({ ...draft, name: t })} placeholder="Call of Duty: Modern Warfare III" />
          </Field>
          <FieldRow>
            <Field label="Short name" style={{ flex: 1, minWidth: 130 }}>
              <Input value={draft.short_name} maxLength={30} onChangeText={(t) => setDraft({ ...draft, short_name: t })} placeholder="MW3" />
            </Field>
            <Field label="Also known as" style={{ flex: 2, minWidth: 180 }}>
              <Input value={draft.aliases} onChangeText={(t) => setDraft({ ...draft, aliases: t })} placeholder="cod, call of duty" />
            </Field>
          </FieldRow>
          <Button title="Add" kind="accent" onPress={create} style={{ alignSelf: 'flex-start' }} />
        </Section>
        {games === null ? (
          <Loading />
        ) : games.length === 0 ? (
          <Text style={fs.hint}>No games yet.</Text>
        ) : (
          games.map((g) => (
            <GameRow
              key={`${g.id}|${g.aliases.join(',')}`}
              game={g}
              others={games.filter((x) => x.id !== g.id)}
              onMerge={merge}
              onChange={(n) => setGames((list) => (list || []).map((x) => (x.id === n.id ? n : x)))}
              onDelete={remove}
              hubName={hubName}
              sgdb={sgdb}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

/** The SteamGridDB API key (admins) and filling in artwork (moderators). */
function SteamGridSettings({ sgdb, onChanged }: { sgdb: Sgdb; onChanged: () => void }) {
  const { api, user } = useSession();
  const [s, setS] = useState<any>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user?.is_admin) api.get<{ settings: any }>('/admin/settings').then((r) => setS(r.settings)).catch(() => {});
  }, [api, user?.is_admin]);
  const save = async (body: Record<string, unknown>, message?: string) => {
    setBusy(true);
    try {
      setS((await api.patch<{ settings: any }>('/admin/settings', body)).settings);
      setKey('');
      if (message) toast(message);
      onChanged();
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const fill = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ queued: number }>('/games/steamgriddb/fill');
      toast(r.queued ? `Finding artwork for ${r.queued} game${r.queued === 1 ? '' : 's'}; it shows up in a minute or two` : 'Every game already has its artwork');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Artwork from SteamGridDB" hint="Covers, title logos and banners from SteamGridDB, picked per game or filled in on their own. Its artists are credited on each game's page.">
      {!!user?.is_admin && !!s && (
        <>
          <FieldRow>
            <Input
              value={key}
              onChangeText={setKey}
              secureTextEntry
              autoComplete="off"
              placeholder={s.steamgriddb_key_set ? 'A key is saved; paste a new one to replace it' : 'SteamGridDB API key'}
              style={{ flex: 1, minWidth: 200 }}
            />
            <Button title="Save key" disabled={busy || !key.trim()} onPress={() => save({ steamgriddb_api_key: key }, 'API key saved')} />
            {s.steamgriddb_key_set && <Button title="Remove" kind="ghost" disabled={busy} onPress={() => save({ steamgriddb_api_key: null }, 'API key removed')} />}
          </FieldRow>
          <Text style={fs.hint}>
            {'Get one from your SteamGridDB account under '}
            <Text style={{ color: colors.link }} onPress={() => Linking.openURL('https://www.steamgriddb.com/profile/preferences/api')}>
              Preferences, API
            </Text>
            . It is never shown again here.
          </Text>
          <Toggle
            label="Fill in artwork for new games"
            hint="Takes SteamGridDB's best-rated cover, logo and banner when a game is added."
            value={s.steamgriddb_auto !== 'false' && s.steamgriddb_auto !== false}
            disabled={busy}
            onChange={(v) => save({ steamgriddb_auto: v })}
          />
        </>
      )}
      {sgdb.configured ? (
        <Button title="Fill in missing artwork" icon="refresh" disabled={busy} onPress={fill} style={{ alignSelf: 'flex-start' }} />
      ) : (
        !user?.is_admin && <Text style={fs.hint}>An admin needs to add a SteamGridDB API key first.</Text>
      )}
    </Section>
  );
}

function GameRow({
  game,
  others,
  onChange,
  onDelete,
  onMerge,
  hubName,
  sgdb,
}: {
  game: Game;
  others: Game[];
  onChange: (g: Game) => void;
  onDelete: (g: Game) => void;
  onMerge: (g: Game, into: string) => void;
  hubName: string | null;
  sgdb: Sgdb;
}) {
  const { api } = useSession();
  const [picking, setPicking] = useState(false);
  const locked = !!game.from_hub; // kept up to date by the hub and changed there
  const [form, setForm] = useState({ name: game.name, short_name: game.short_name || '', aliases: game.aliases.join(', ') });
  const dirty = form.name !== game.name || form.short_name !== (game.short_name || '') || form.aliases !== game.aliases.join(', ');
  const save = async () => {
    try {
      onChange((await api.patch<{ game: Game }>(`/games/${game.id}`, form)).game);
      toast('Saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  const upload = async () => {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      onChange((await api.sendFile<{ game: Game }>(`/games/${game.id}/artwork`, 'artwork', file)).game);
      toast('Artwork saved');
    } catch (e: any) {
      toast(e.message);
    }
  };
  return (
    <Section>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Pressable onPress={upload} disabled={locked} style={{ width: 72, aspectRatio: 2 / 3, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={locked ? 'Artwork from the hub' : 'Upload artwork (portrait, like a box cover)'}>
          {game.artwork_url ? <Image source={{ uri: api.abs(game.artwork_url)! }} style={{ width: '100%', height: '100%' }} contentFit="cover" /> : <Icon name="image" size={26} color={colors.text2} />}
        </Pressable>
        <View style={{ flex: 1, gap: 6 }}>
          {!!game.hero_url && <Image source={{ uri: api.abs(game.hero_url)! }} style={{ width: '100%', aspectRatio: 96 / 31, borderRadius: 8 }} contentFit="cover" />}
          {!!game.logo_url && <Image source={{ uri: api.abs(game.logo_url)! }} style={{ height: 36, width: '60%' }} contentFit="contain" contentPosition="left" />}
          <Text style={fs.hint}>
            <Text style={{ color: colors.link }} onPress={() => router.push(`/g/${encodeURIComponent(game.id)}` as any)}>{`/g/${game.id}`}</Text>
            {` · ${game.video_count} here · ${game.network_count} from the network`}
          </Text>
          {locked && <Badge text={`From ${hubName || 'the hub'}`} />}
        </View>
      </View>
      <FieldRow>
        <Field label="Name" style={{ flex: 2, minWidth: 180 }}>
          <Input value={form.name} maxLength={80} editable={!locked} onChangeText={(t) => setForm({ ...form, name: t })} />
        </Field>
        <Field label="Short name" style={{ flex: 1, minWidth: 120 }}>
          <Input value={form.short_name} maxLength={30} editable={!locked} onChangeText={(t) => setForm({ ...form, short_name: t })} />
        </Field>
      </FieldRow>
      <Field label="Also known as">
        <Input value={form.aliases} editable={!locked} onChangeText={(t) => setForm({ ...form, aliases: t })} placeholder="Other names other instances might use, separated by commas" />
      </Field>
      {!locked && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {sgdb.configured && <Button title="Artwork" icon="image" small onPress={() => setPicking(true)} />}
          <Button title="Save" small kind="accent" disabled={!dirty} onPress={save} />
          {others.length > 0 && (
            <View style={{ width: 170 }}>
              <Select small value={null} placeholder="Merge into…" options={others.map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }))} onChange={(v) => onMerge(game, v)} />
            </View>
          )}
          <Button title="Delete" small onPress={() => onDelete(game)} />
        </View>
      )}
      {picking && <SteamGridPicker game={game} onClose={() => setPicking(false)} onChange={onChange} />}
    </Section>
  );
}

const KINDS: [string, string][] = [
  ['cover', 'Cover'],
  ['logo', 'Title logo'],
  ['hero', 'Banner'],
];
const LABEL = Object.fromEntries(KINDS);

/** Pick a game's cover, title logo or banner from SteamGridDB. */
function SteamGridPicker({ game, onClose, onChange }: { game: Game; onClose: () => void; onChange: (g: Game) => void }) {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState(game.name);
  const [results, setResults] = useState<any[] | null>(null);
  const [sgdbId, setSgdbId] = useState<number | null>(game.sgdb_id || null);
  const [kind, setKind] = useState('cover');
  const [images, setImages] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const search = useCallback(
    async (query: string) => {
      setResults(null);
      try {
        setResults((await api.get<{ results: any[] }>(`/games/steamgriddb/search?q=${encodeURIComponent(query.trim())}`)).results);
      } catch (e: any) {
        toast(e.message);
        setResults([]);
      }
    },
    [api],
  );
  useEffect(() => {
    search(game.name);
  }, [search, game.name]);
  useEffect(() => {
    if (!sgdbId) return;
    let dead = false;
    setImages(null);
    api
      .get<{ images: any[] }>(`/games/${encodeURIComponent(game.id)}/steamgriddb?kind=${kind}&sgdb_id=${sgdbId}`)
      .then((r) => !dead && setImages(r.images))
      .catch((e) => {
        if (dead) return;
        toast(e.message);
        setImages([]);
      });
    return () => {
      dead = true;
    };
  }, [api, sgdbId, kind, game.id]);
  const apply = async (img: any) => {
    setBusy(img.id);
    try {
      const r = await api.post<{ game: Game }>(`/games/${encodeURIComponent(game.id)}/steamgriddb`, { kind, sgdb_id: sgdbId, image_id: img.id });
      onChange(r.game);
      toast(`${LABEL[kind]} saved`);
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  };
  const ratio = kind === 'cover' ? 2 / 3 : kind === 'hero' ? 96 / 31 : 2;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 8 }}>
          <Heading style={{ flex: 1, fontSize: 19 }} numberOfLines={1}>{`Artwork for ${game.name}`}</Heading>
          <Button title="Done" kind="accent" small onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={[{ padding: 16, gap: 12, paddingBottom: 24 + insets.bottom }, readable]} keyboardShouldPersistTaps="handled">
          <FieldRow>
            <Input value={q} onChangeText={setQ} onSubmitEditing={() => q.trim() && search(q)} style={{ flex: 1, minWidth: 180 }} />
            <Button title="Search" disabled={!q.trim()} onPress={() => search(q)} />
          </FieldRow>
          {results === null ? (
            <Loading />
          ) : results.length === 0 ? (
            <Text style={fs.hint}>SteamGridDB has nothing by that name. Try another spelling.</Text>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {results.map((r) => (
                <Chip key={r.id} label={`${r.name}${r.year ? ` (${r.year})` : ''}${r.verified ? ' ✓' : ''}`} active={sgdbId === r.id} onPress={() => setSgdbId(r.id)} />
              ))}
            </View>
          )}
          {!!sgdbId && (
            <>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {KINDS.map(([k, label]) => (
                  <Chip key={k} label={label} active={kind === k} onPress={() => setKind(k)} />
                ))}
              </View>
              {images === null ? (
                <Loading />
              ) : images.length === 0 ? (
                <Text style={fs.hint}>{`No ${LABEL[kind].toLowerCase()} for this game yet.`}</Text>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                  {images.map((img) => (
                    <Pressable key={img.id} disabled={!!busy} onPress={() => apply(img)} style={{ width: kind === 'cover' ? 104 : 220, gap: 4 }} accessibilityLabel={img.author ? `By ${img.author}` : 'Use this one'}>
                      <Image source={{ uri: img.thumb }} style={{ width: '100%', aspectRatio: ratio, borderRadius: 8, backgroundColor: colors.surface2 }} contentFit={kind === 'logo' ? 'contain' : 'cover'} />
                      <Text style={fs.hint} numberOfLines={1}>
                        {busy === img.id ? 'Saving…' : img.author || ' '}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}
          <Text style={fs.hint}>Images are made by the SteamGridDB community and credited on the game's page. A copy is kept on this site.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}
